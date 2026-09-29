/**
 * v2 Routes — Clean Architecture webhook routes (Strangler Pattern).
 * These run ALONGSIDE the v1 routes, not replacing them.
 * All new traffic should use /api/v2/ endpoints.
 * The old /api/whatsapp-webhook remains for backward compatibility.
 */
import { Router, Request, Response } from 'express';
import { AppConfig } from '../../shared/config/AppConfig.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';
import { buildReceiveMessageUseCase, convRepo, leadRepo } from './container.js';

const v2Router = Router();

// ─── Health & Telemetry ────────────────────────────────────────────────────
v2Router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', version: '2.0.0', timestamp: new Date().toISOString() });
});

v2Router.get('/ready', (_req: Request, res: Response) => {
  const groqConfigured = !!AppConfig.groq.apiKey;
  const metaConfigured = !!AppConfig.meta.accessToken;
  res.status(groqConfigured ? 200 : 503).json({
    ready: groqConfigured,
    services: {
      groq: groqConfigured ? 'ok' : 'missing_api_key',
      whatsapp: metaConfigured ? 'ok' : 'simulation_mode',
      smtp: !!AppConfig.smtp.pass ? 'ok' : 'simulation_mode',
    },
  });
});

// ─── Webhook Verification (GET) ───────────────────────────────────────────
v2Router.get('/whatsapp-webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === AppConfig.meta.verifyToken) {
    logger.info('[v2 Webhook] Meta verification OK');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ─── Incoming Message (POST) ──────────────────────────────────────────────
// NOTE: We process BEFORE responding to avoid Vercel Lambda freezing async
// operations after res.json() is called. Meta's timeout is 20s; Groq takes ~5-8s.
v2Router.post('/whatsapp-webhook', async (req: Request, res: Response) => {
  let phone = '', text = '', name = 'Cliente';
  const body = req.body;

  try {
    // 1. Meta WhatsApp Cloud API payload
    if (body.entry?.[0]?.changes?.[0]?.value) {
      const val = body.entry[0].changes[0].value;
      const eventType = val.messages ? 'message' : val.statuses ? 'status' : 'other';
      logger.info('[v2 Webhook] WhatsApp event received', { eventType });

      if (val.messages?.[0]) {
        const msg = val.messages[0];
        phone = msg.from;
        text = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
        name = val.contacts?.[0]?.profile?.name || 'Cliente WhatsApp';
      } else {
        if (val.statuses?.[0]) {
          logger.info('[v2 Webhook] Status update', val.statuses[0]);
        }
        return res.status(200).json({ status: 'received' });
      }
    }
    // 2. Meta Messenger payload
    else if (body.entry?.[0]?.messaging?.[0]) {
      const messaging = body.entry[0].messaging[0];
      if (messaging.message?.is_echo) {
        logger.info('[v2 Webhook] Ignoring Messenger echo');
        return res.status(200).json({ status: 'received' });
      }
      if (messaging.message) {
        phone = messaging.sender?.id || '';
        text = messaging.message.text || '';
        name = 'Cliente Messenger';
      } else if (messaging.postback) {
        phone = messaging.sender?.id || '';
        text = messaging.postback.title || messaging.postback.payload || '';
        name = 'Cliente Messenger';
      } else {
        return res.status(200).json({ status: 'received' });
      }
    }
    // 3. Twilio payload
    else if (body.From && body.Body) {
      phone = body.From.replace('whatsapp:', '');
      text = body.Body;
      name = body.ProfileName || 'Cliente Twilio';
    }
    // 4. Playground / Simulator payload
    else if (body.phone && body.text) {
      phone = body.phone;
      text = body.text;
      name = body.name || 'Cliente Simulado';
    }

    if (!phone || !text) {
      logger.warn('[v2 Webhook] Missing phone or text, skipping');
      return res.status(200).json({ status: 'received' });
    }

    // Run use case BEFORE responding — ensures Vercel doesn't freeze the Lambda
    const useCase = buildReceiveMessageUseCase();
    await useCase.execute({ phone, text, name });
  } catch (err: any) {
    logger.error('[v2 Webhook] Unhandled error', { error: err.message, stack: err.stack });
  }

  // Always return 200 to Meta (prevents retries even on internal errors)
  return res.status(200).json({ status: 'received' });
});

// ─── Conversations (CRM) ──────────────────────────────────────────────────
v2Router.get('/chats', async (req: Request, res: Response) => {
  const tenantId = (req.query.tenantId as string) || AppConfig.tenant.defaultId;
  try {
    const chats = await convRepo.findAll(tenantId);
    return res.json(chats);
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

v2Router.post('/chats/:phone/toggle-bot', async (req: Request, res: Response) => {
  const { phone } = req.params;
  const { bot_disabled } = req.body;
  const tenantId = req.body.tenantId || AppConfig.tenant.defaultId;
  try {
    const conv = await convRepo.findByPhone(tenantId, phone);
    conv.botDisabled = bot_disabled;
    await convRepo.save(conv);
    return res.json({ success: true, conv });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// Human agent sends manual message
v2Router.post('/chats/:phone/message', async (req: Request, res: Response) => {
  const { phone } = req.params;
  const { text } = req.body;
  const tenantId = req.body.tenantId || AppConfig.tenant.defaultId;
  if (!text) return res.status(400).json({ error: 'Text is required' });
  try {
    const conv = await convRepo.findByPhone(tenantId, phone);
    conv.messages.push({ sender: 'agent', text, timestamp: new Date().toISOString() });
    conv.lastMessageAt = new Date().toISOString();
    conv.botDisabled = true;
    await convRepo.save(conv);
    
    // Send via WhatsApp
    const { accessToken, phoneNumberId } = AppConfig.meta;
    if (accessToken && phoneNumberId) {
      await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'text', text: { preview_url: false, body: text } }),
      });
    }
    
    return res.json({ success: true, conv });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// ─── Copilot ──────────────────────────────────────────────────────────────
v2Router.post('/copilot/query', async (req: Request, res: Response) => {
  const { question, history } = req.body;
  const tenantId = req.body.tenantId || AppConfig.tenant.defaultId;
  if (!question) return res.status(400).json({ error: 'Falta la pregunta' });
  
  try {
    const leads = await leadRepo.findAll(tenantId);
    const chats = await convRepo.findAll(tenantId);
    
    const databaseContext = {
      qualified_leads: leads,
      chats_metadata: chats.map(c => ({ phone: c.phone, nombre: c.nombre, phase: c.state.phase, botDisabled: c.botDisabled, lastMessageAt: c.lastMessageAt })),
      current_time: new Date().toISOString(),
      metadata: { total_leads: leads.length, total_chats: chats.length }
    };
    
    const systemInstruction = `Eres el Copiloto de Ventas. Responde analizando: ${JSON.stringify(databaseContext)}. Usa Markdown y pesos MXN.`;
    
    const chatHistory = [
      { role: 'system', content: systemInstruction },
      ...(history || []).map((m: any) => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.text })),
      { role: 'user', content: question }
    ];
    
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AppConfig.groq.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: AppConfig.groq.model, messages: chatHistory, temperature: 0.2 }),
    });
    
    const data = await response.json() as any;
    return res.json({ answer: data.choices?.[0]?.message?.content || '' });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// ─── Leads (CRM) ─────────────────────────────────────────────────────────
v2Router.get('/leads', async (req: Request, res: Response) => {
  const tenantId = (req.query.tenantId as string) || AppConfig.tenant.defaultId;
  try {
    const leads = await leadRepo.findAll(tenantId);
    return res.json(leads);
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

v2Router.post('/leads/:id/contacted', async (req: Request, res: Response) => {
  const { id } = req.params;
  const tenantId = req.body.tenantId || AppConfig.tenant.defaultId;
  try {
    await leadRepo.updateStatus(tenantId, id, 'contacted');
    return res.json({ success: true });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

v2Router.post('/leads/:id/notes', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { private_notes, tenantId } = req.body;
  const tenant = tenantId || AppConfig.tenant.defaultId;
  try {
    await leadRepo.updateNotes(tenant, id, private_notes);
    return res.json({ success: true });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// ─── Utility ─────────────────────────────────────────────────────────────
v2Router.post('/reset-demo', async (req: Request, res: Response) => {
  // Solo aplicable a InMemory, para Firestore se requeriría un borrado de colección completo
  // Simplemente devolvemos OK para que el frontend limpie su estado visual
  return res.json({ success: true });
});

export { v2Router };

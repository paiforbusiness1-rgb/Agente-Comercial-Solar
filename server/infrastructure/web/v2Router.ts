/**
 * v2 Routes — Clean Architecture webhook & API routes (Strangler Pattern).
 * Standardized under ISO/IEC 27034-1 & SSD (Rule 6).
 */
import { Router, Request, Response, NextFunction } from 'express';
import { AppConfig } from '../../shared/config/AppConfig.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';
import { buildReceiveMessageUseCase, convRepo, leadRepo } from './container.js';
import { AuthService, JwtPayload } from '../services/AuthService.js';
import { GoogleAuthService } from '../services/GoogleAuthService.js';
import { RateLimiterService } from '../services/RateLimiterService.js';
import { AuditLogService } from '../services/AuditLogService.js';
import { getClientIp } from '../../shared/utils/ipUtils.js';

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

const v2Router = Router();

// ─── Middlewares ─────────────────────────────────────────────────────────

/**
 * Serverless-compatible Rate Limiter for Login Endpoint
 */
export async function authRateLimiter(req: Request, res: Response, next: NextFunction) {
  const ip = getClientIp(req);

  const check = await RateLimiterService.checkRateLimit(ip);
  if (!check.allowed) {
    logger.warn('[AuthRateLimiter] IP blocked due to excessive failed attempts', { ip, resetInSeconds: check.resetInSeconds });
    return res.status(429).json({
      error: `Demasiados intentos fallidos de inicio de sesión. Por favor espere ${check.resetInSeconds} segundos antes de reintentar.`,
      resetInSeconds: check.resetInSeconds,
    });
  }
  next();
}

/**
 * Dual Extraction Authentication Middleware (Cookie + Bearer fallback)
 * Priorities:
 * 1. req.cookies.token or Cookie header 'token' (Browser Frontend with HttpOnly)
 * 2. Authorization: Bearer <token> (External API clients, Postman, Webhooks)
 */
export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  let token: string | undefined;

  // 1. Try Cookie header first (Refinamiento A: Frontend Primary)
  const cookies = AuthService.parseCookies(req.headers.cookie);
  if (cookies.token) {
    token = cookies.token;
  }

  // 2. Fallback to Authorization Header if Cookie not present
  if (!token && req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else {
      token = authHeader.trim();
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'No autenticado. Cookie o Token de autorización faltante.' });
  }

  const verification = AuthService.verifyToken(token);
  if (!verification.valid || !verification.payload) {
    return res.status(401).json({ error: 'Sesión inválida o expirada.', details: verification.error });
  }

  req.user = verification.payload;
  next();
}

/**
 * Role-Based Access Control (RBAC) Middleware
 */
export function requireRole(allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Usuario no autenticado.' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      logger.warn('[RBAC] Forbidden access attempt', { user: req.user.email, role: req.user.role, required: allowedRoles });
      return res.status(403).json({ error: 'Acceso denegado. Se requieren permisos elevados.' });
    }
    next();
  };
}

// ─── Authentication Endpoints ─────────────────────────────────────────────

v2Router.post('/auth/login', authRateLimiter, async (req: Request, res: Response) => {
  const ip = getClientIp(req);

  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Correo y contraseña son requeridos.' });
  }

  const configuredAdminEmail = AppConfig.auth.adminEmail.toLowerCase().trim();
  const inputEmail = String(email).toLowerCase().trim();

  // Validate admin email match
  if (inputEmail !== configuredAdminEmail) {
    await RateLimiterService.registerFailedAttempt(ip);
    return res.status(401).json({ error: 'Credenciales inválidas.' });
  }

  // Validate password using scrypt hash comparison
  const isValidPassword = AuthService.verifyPassword(password, AppConfig.auth.adminPasswordHash);
  if (!isValidPassword) {
    await RateLimiterService.registerFailedAttempt(ip);
    return res.status(401).json({ error: 'Credenciales inválidas.' });
  }

  // Clear rate limit counter upon successful login
  await RateLimiterService.resetRateLimit(ip);

  const user = { id: 'admin-1', email: configuredAdminEmail, role: 'admin' as const };
  const token = AuthService.generateToken(user);

  // Set HttpOnly Cookie (SameSite=Strict, Secure in prod)
  const cookieHeader = AuthService.createHttpOnlyCookie(token);
  res.setHeader('Set-Cookie', cookieHeader);

  logger.info('[Auth] Successful login for admin', { email: configuredAdminEmail, ip });

  return res.json({
    success: true,
    message: 'Inicio de sesión exitoso',
    user,
    token, // Optional for external API clients
  });
});

// ─── Google OAuth Endpoint ────────────────────────────────────────────────

v2Router.post('/auth/google', authRateLimiter, async (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const { idToken } = req.body || {};

  if (!idToken || typeof idToken !== 'string') {
    return res.status(400).json({ error: 'Se requiere un ID Token de Google válido.' });
  }

  const googleUser = await GoogleAuthService.verifyGoogleToken(idToken);

  if (!googleUser) {
    await RateLimiterService.registerFailedAttempt(ip);
    return res.status(401).json({ error: 'Token de Google inválido o expirado.' });
  }

  await RateLimiterService.resetRateLimit(ip);

  const user = {
    id: googleUser.uid,
    email: googleUser.email,
    role: 'admin' as const, // Demo mode: any Google user gets admin role
  };

  const token = AuthService.generateToken(user);
  const cookieHeader = AuthService.createHttpOnlyCookie(token);
  res.setHeader('Set-Cookie', cookieHeader);

  logger.info('[Auth] Successful Google OAuth login', { email: googleUser.email, ip });

  return res.json({
    success: true,
    message: 'Inicio de sesión con Google exitoso',
    user,
  });
});

v2Router.get('/auth/me', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  return res.json({
    authenticated: true,
    user: req.user,
  });
});

v2Router.post('/auth/logout', (req: Request, res: Response) => {
  res.setHeader('Set-Cookie', AuthService.createLogoutCookie());
  return res.json({ success: true, message: 'Sesión cerrada correctamente' });
});

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

  // Always return 200 to Meta
  return res.status(200).json({ status: 'received' });
});

// ─── Conversations (CRM - Protected) ──────────────────────────────────────

v2Router.get('/chats', requireAuth, async (req: Request, res: Response) => {
  const tenantId = (req.query.tenantId as string) || AppConfig.tenant.defaultId;
  try {
    const chats = await convRepo.findAll(tenantId);
    return res.json(chats);
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

v2Router.get('/chats/trash', requireAuth, requireRole(['admin', 'agent']), async (req: Request, res: Response) => {
  const tenantId = (req.query.tenantId as string) || AppConfig.tenant.defaultId;
  try {
    const trashedChats = await convRepo.findTrash(tenantId);
    return res.json(trashedChats);
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

v2Router.delete('/chats/:phone', requireAuth, requireRole(['admin']), async (req: AuthenticatedRequest, res: Response) => {
  const { phone } = req.params;
  const tenantId = (req.query.tenantId as string) || req.body?.tenantId || AppConfig.tenant.defaultId;
  const ip = getClientIp(req);

  try {
    const success = await convRepo.softDelete(tenantId, phone, req.user!.email);
    if (!success) {
      return res.status(404).json({ error: 'Chat no encontrado para archivar' });
    }

    // Register immutable Audit Log event (ISO/IEC 27034-1 & Regla 8)
    await AuditLogService.logEvent({
      eventType: 'CHAT_SOFT_DELETED',
      userEmail: req.user!.email,
      userRole: req.user!.role,
      resourceId: phone,
      tenantId,
      ipAddress: ip,
      details: { action: 'Soft Delete chat', phone },
    });

    return res.json({ success: true, message: 'Chat archivado en la Papelera de Reciclaje correctamente.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

v2Router.post('/chats/:phone/restore', requireAuth, requireRole(['admin']), async (req: AuthenticatedRequest, res: Response) => {
  const { phone } = req.params;
  const tenantId = (req.query.tenantId as string) || req.body?.tenantId || AppConfig.tenant.defaultId;
  const ip = getClientIp(req);

  try {
    const success = await convRepo.restore(tenantId, phone);
    if (!success) {
      return res.status(404).json({ error: 'Chat no encontrado para restaurar' });
    }

    // Register immutable Audit Log event
    await AuditLogService.logEvent({
      eventType: 'CHAT_RESTORED',
      userEmail: req.user!.email,
      userRole: req.user!.role,
      resourceId: phone,
      tenantId,
      ipAddress: ip,
      details: { action: 'Restaurar chat', phone },
    });

    return res.json({ success: true, message: 'Chat restaurado a la lista activa correctamente.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Refinamiento A: Purga física automática/manual de chats eliminados hace más de 30 días
v2Router.post('/chats/purge-expired', requireAuth, requireRole(['admin']), async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = (req.query.tenantId as string) || req.body?.tenantId || AppConfig.tenant.defaultId;
  const retentionDays = parseInt((req.query.retentionDays as string) || req.body?.retentionDays || '30', 10);
  const ip = getClientIp(req);

  try {
    const purgedCount = await convRepo.purgeExpiredTrash(tenantId, retentionDays);
    
    if (purgedCount > 0) {
      await AuditLogService.logEvent({
        eventType: 'TRASH_PURGED',
        userEmail: req.user!.email,
        userRole: req.user!.role,
        resourceId: `purged_${purgedCount}_items`,
        tenantId,
        ipAddress: ip,
        details: { action: 'Purge Expired Trash', purgedCount, retentionDays },
      });
    }

    return res.json({
      success: true,
      message: `Se han purgado permanentemente ${purgedCount} conversaciones archivadas con más de ${retentionDays} días en la papelera.`,
      purgedCount,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Refinamiento C: Paginated Audit Log retrieval endpoint
v2Router.get('/audit-logs', requireAuth, requireRole(['admin']), async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = (req.query.tenantId as string) || AppConfig.tenant.defaultId;
  const page = parseInt((req.query.page as string) || '1', 10);
  const limit = parseInt((req.query.limit as string) || '50', 10);
  const eventType = req.query.eventType as string | undefined;

  try {
    const paginatedLogs = await AuditLogService.getLogs(tenantId, page, limit, eventType);
    return res.json(paginatedLogs);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

v2Router.post('/chats/:phone/toggle-bot', requireAuth, async (req: Request, res: Response) => {
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
v2Router.post('/chats/:phone/message', requireAuth, async (req: Request, res: Response) => {
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

// ─── Copilot (Protected) ──────────────────────────────────────────────────

v2Router.post('/copilot/query', requireAuth, async (req: Request, res: Response) => {
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

// ─── Leads (CRM - Protected) ──────────────────────────────────────────────

v2Router.get('/leads', requireAuth, async (req: Request, res: Response) => {
  const tenantId = (req.query.tenantId as string) || AppConfig.tenant.defaultId;
  try {
    const leads = await leadRepo.findAll(tenantId);
    return res.json(leads);
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

v2Router.post('/leads/:id/contacted', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  const tenantId = req.body.tenantId || AppConfig.tenant.defaultId;
  try {
    await leadRepo.updateStatus(tenantId, id, 'contacted');
    return res.json({ success: true });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

v2Router.post('/leads/:id/notes', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { private_notes, tenantId } = req.body;
  const tenant = tenantId || AppConfig.tenant.defaultId;
  try {
    await leadRepo.updateNotes(tenant, id, private_notes);
    return res.json({ success: true });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// ─── Utility ─────────────────────────────────────────────────────────────

v2Router.post('/reset-demo', requireAuth, async (req: Request, res: Response) => {
  return res.json({ success: true });
});

export { v2Router };

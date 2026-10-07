/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Vercel Serverless Function entry point.
 * Architecture: Strangler Pattern — v1 routes remain for backward compat.
 * All NEW traffic should use /api/v2/* routes (Clean Architecture).
 * v1 will be deprecated once v2 is validated in production.
 */

import express from 'express';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import nodemailer from 'nodemailer';
// ─── v2 Architecture (Clean Architecture / Tool Calling) ───────────────────
import { v2Router } from '../server/infrastructure/web/v2Router.js';
import { initRepositories } from '../server/infrastructure/web/container.js';

// Firebase client config — these are public values (same as firebase-applet-config.json)
// Hardcoded here to avoid runtime file-read issues in Vercel serverless environment
const firebaseConfig = {
  projectId: 'agente-comercial-solar',
  appId: '1:615897776902:web:1db49554bc7c0699755487',
  apiKey: 'AIzaSyCMJtiqXdtrt7U-u4M0-PHljFCBQKJwp9g',
  authDomain: 'agente-comercial-solar.firebaseapp.com',
  firestoreDatabaseId: '(default)',
  storageBucket: 'agente-comercial-solar.firebasestorage.app',
  messagingSenderId: '615897776902',
};

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- FIREBASE ADMINISTRATION INITIALIZATION ---
let db: any = null;
let isInMemory = false;
const inMemoryChats: Record<string, any> = {};
const inMemoryLeads: Record<string, any> = {};

function initFirebase() {
  // Avoid re-initializing on hot reloads (Vercel reuses instances between requests)
  if (getApps().length > 0) {
    const dbId = firebaseConfig.firestoreDatabaseId;
    db = dbId && dbId !== '(default)' ? getFirestore(dbId) : getFirestore();
    initRepositories(db);
    return;
  }

  try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.project_id || firebaseConfig.projectId,
      });
      console.log('Firebase Admin SDK initialized from FIREBASE_SERVICE_ACCOUNT_JSON env var');
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      initializeApp({ projectId: firebaseConfig.projectId });
      console.log('Firebase Admin SDK initialized using GOOGLE_APPLICATION_CREDENTIALS');
    } else {
      console.warn('No Firebase Admin credentials found. Falling back to in-memory mode.');
      isInMemory = true;
      initRepositories(null);
      return;
    }
    const dbId = firebaseConfig.firestoreDatabaseId;
    db = dbId && dbId !== '(default)' ? getFirestore(dbId) : getFirestore();
    console.log(`Firebase Admin SDK connected. Database ID: ${dbId || '(default)'}`);
  } catch (error) {
    console.warn('Firebase Admin SDK failed to initialize. Falling back to in-memory mode:', error);
    isInMemory = true;
  }

  // Wire Firestore db into v2 repositories (Strangler Pattern)
  if (!isInMemory && db) {
    initRepositories(db);
  } else {
    initRepositories(null);
  }
}

initFirebase();

// ─── Mount v2 Router (Strangler Pattern — new Clean Architecture routes) ───
app.use('/api/v2', v2Router);

// --- DB HELPERS ---
async function getChatDoc(phone: string): Promise<any> {
  if (isInMemory) {
    if (!inMemoryChats[phone]) {
      inMemoryChats[phone] = {
        id: phone, phone, nombre: 'Cliente', botDisabled: false,
        messages: [], lastMessageAt: new Date().toISOString(),
      };
    }
    return inMemoryChats[phone];
  }
  const docRef = db.collection('tenants/o3energy_mexico/chats').doc(phone);
  const doc = await docRef.get();
  if (!doc.exists) {
    const newChat = { phone, nombre: 'Cliente', botDisabled: false, messages: [], lastMessageAt: new Date().toISOString() };
    await docRef.set(newChat);
    return { id: phone, ...newChat };
  }
  return { id: doc.id, ...doc.data() };
}

async function updateChatDoc(phone: string, data: any): Promise<void> {
  if (isInMemory) { inMemoryChats[phone] = { ...inMemoryChats[phone], ...data }; return; }
  await db.collection('tenants/o3energy_mexico/chats').doc(phone).set(data, { merge: true });
}

async function createQualifiedLead(lead: any): Promise<void> {
  const leadId = lead.id || `lead_${Date.now()}`;
  if (isInMemory) {
    inMemoryLeads[leadId] = { ...lead, id: leadId, status: 'pending_review', createdAt: new Date().toISOString() };
  } else {
    await db.collection('tenants/o3energy_mexico/qualified_leads').doc(leadId).set({ ...lead, status: 'pending_review', createdAt: new Date().toISOString() });
  }
}

// --- EMAIL NOTIFICATION ---
async function sendSalesEmailNotification(lead: any, phone: string): Promise<boolean> {
  const senderEmail = process.env.SENDER_EMAIL || 'alertas@o3energy.mx';
  const senderPassword = process.env.SENDER_PASSWORD;
  const salesEmail = process.env.SALES_EMAIL || 'ventas@o3energy.mx';
  const smtpServer = process.env.SMTP_SERVER || 'smtp.gmail.com';
  const smtpPort = parseInt(process.env.SMTP_PORT || '587');

  const subject = `🔥 Nuevo Lead Calificado: ${lead.nombre || 'Cliente'} (${lead.montoRecibo || 'Sin monto'})`;
  const bodyHtml = `
    <div style="font-family: sans-serif; max-width: 600px; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; margin: 0 auto;">
      <div style="background-color: #ea580c; color: white; padding: 24px; text-align: center;">
        <h1 style="margin: 0; font-size: 20px;">🔥 ¡Nuevo Lead Calificado!</h1>
        <p style="margin: 4px 0 0 0; font-size: 14px; opacity: 0.9;">O3 Energy Sales Automation AI</p>
      </div>
      <div style="padding: 24px; color: #334155;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 10px 0; font-weight: bold; color: #64748b;">Nombre:</td><td style="padding: 10px 0;">${lead.nombre}</td></tr>
          <tr><td style="padding: 10px 0; font-weight: bold; color: #64748b;">WhatsApp:</td><td style="padding: 10px 0; font-family: monospace;">+${phone}</td></tr>
          <tr><td style="padding: 10px 0; font-weight: bold; color: #64748b;">Gasto CFE:</td><td style="padding: 10px 0; color: #ea580c; font-weight: bold;">${lead.montoRecibo}</td></tr>
          <tr><td style="padding: 10px 0; font-weight: bold; color: #64748b;">Sistema:</td><td style="padding: 10px 0;">${lead.sistemaEstimado}</td></tr>
          <tr><td style="padding: 10px 0; font-weight: bold; color: #64748b;">Costo:</td><td style="padding: 10px 0; color: #ea580c; font-weight: bold;">${lead.costoEstimado}</td></tr>
        </table>
        <div style="text-align: center; margin-top: 24px;">
          <a href="https://wa.me/${phone}" style="background-color: #ea580c; color: white; padding: 12px 24px; border-radius: 12px; text-decoration: none; font-weight: bold;">💬 Atender en WhatsApp</a>
        </div>
      </div>
    </div>
  `;

  if (!senderPassword) {
    console.log(`[SMTP SIMULACIÓN] Lead calificado: ${lead.nombre} (${salesEmail})`);
    return true;
  }
  try {
    const transporter = nodemailer.createTransport({ host: smtpServer, port: smtpPort, secure: smtpPort === 465, auth: { user: senderEmail, pass: senderPassword } });
    await transporter.sendMail({ from: `"Alertas O3 Energy AI" <${senderEmail}>`, to: salesEmail, subject, html: bodyHtml });
    return true;
  } catch (err) {
    console.error('[SMTP ERROR]', err);
    return false;
  }
}

// --- WHATSAPP CLOUD API ---
async function sendWhatsAppMessage(phone: string, text: string): Promise<boolean> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    console.log(`[WHATSAPP SIMULACIÓN] Para +${phone}: ${text.substring(0, 60)}...`);
    return true;
  }
  try {
    const response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'text', text: { preview_url: false, body: text } }),
    });
    const data = await response.json() as any;
    if (response.ok) { console.log(`[WHATSAPP OK] Mensaje a +${phone}`); return true; }
    console.error('[WHATSAPP ERROR]', data);
    return false;
  } catch (err) {
    console.error('[WHATSAPP EXCEPCIÓN]', err);
    return false;
  }
}

// --- LLM PROVIDER (Groq primario + Gemini fallback) ---
import { callLLM } from '../server/infrastructure/ai/LLMProvider.js';
async function callGroqAPI(
  systemInstruction: string,
  messages: { role: string; content: string }[],
  temperature: number = 0.7
): Promise<string> {
  const result = await callLLM(systemInstruction, messages as any, temperature);
  return result.text;
}

// --- SYSTEM PROMPT ---
const SYSTEM_INSTRUCTION = `
Eres un asesor de ventas experto e inteligente de "O3 Energy México", una empresa líder de ingeniería en energía solar enfocada en instalar sistemas fotovoltaicos de alta calidad para hogares y comercios. Tu objetivo es calificar y orientar con calidez a los interesados en reducir su recibo de luz en México.

Sigue rigurosamente estas pautas en español de México, manteniendo un tono profesional, amable y de confianza:

1. **Objetivos de Calificación (Descubrimiento)**:
   - Sé cálido e inicia saludando amigablemente.
   - Pregunta de forma natural el nombre del usuario si aún no lo tienes.
   - Descubre sutilmente si el usuario es el dueño de la propiedad o casa (los paneles requieren la aprobación del propietario).
   - Descubre de cuánto es su gasto o recibo de electricidad promedio, ya sea al mes o al bimestre (monto en pesos mexicanos MXN).

2. **REGLA DE COTIZACIÓN (Gasto mayor a $2,500 MXN)**:
   - Si el gasto del usuario es superior a $2,500 MXN mensuales/bimestrales, debes calcular una estimación rápida:
     - Por ejemplo, si gasta aproximadamente $3,000 MXN bimestrales, dile que se estima un sistema de 4 a 6 paneles solares con un costo aproximado de $80,000 MXN y un retorno de inversión a unos 3 años (ahorrando hasta el 95% de su recibo). Adapta proporcionalmente el costo y cantidad si gastan más.
     - Es un requerimiento OBLIGATORIO y estricto que enfatices textualmente la siguiente advertencia para evitar falsas expectativas comerciales:
       "Este es solo un presupuesto preliminar de arranque, ya que para la cotización real y final se requiere una visita técnica sin costo en su sitio para evaluar la inclinación del techo, sombras y trayectoria eléctrica."

3. **REGLA DE SALIDA (Generación del lead calificado)**:
   - En el momento en que hayas obtenido las respuestas clave (nombre o "Cliente Interesado", monto de recibo y la confirmación de ser dueño/interesado en pre-cotizar) y le hayas presentado la pre-cotización, debes adjuntar OBLIGATORIAMENTE al final absoluto de tu mensaje el siguiente bloque JSON en este formato de tag:
     [QUALIFIED_LEAD: {"nombre": "Nombre del cliente", "montoRecibo": "$X,XXX MXN", "sistemaEstimado": "X paneles", "costoEstimado": "$XX,XXX MXN"}]
   - No muestres ni menciones este bloque JSON explícitamente en el diálogo. Solo colócalo al final exacto de tu respuesta.

Mantén tus respuestas relativamente cortas, fáciles de leer en WhatsApp, usando viñetas donde sea conveniente y usando saltos de línea claros.
`;

function extractQualifiedLead(text: string): { cleanText: string; leadData: any | null } {
  const match = text.match(/\[QUALIFIED_LEAD:\s*(\{.*?\})\s*\]/s);
  if (match) {
    try {
      const leadData = JSON.parse(match[1].trim());
      return { cleanText: text.replace(match[0], '').trim(), leadData };
    } catch (e) { console.error('Error parsing lead JSON:', e); }
  }
  return { cleanText: text, leadData: null };
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Webhook verification & incoming message (Redirect to V2)
app.use(['/whatsapp-webhook', '/api/whatsapp-webhook'], (req, res, next) => {
  req.url = '/whatsapp-webhook'; // Rewrites the URL so v2Router matches it
  v2Router(req, res, next);
});

// GET chats (Updated for Strangler Pattern to read from V2 location)
app.get('/api/chats', async (_req, res) => {
  try {
    if (isInMemory) return res.json(Object.values(inMemoryChats));
    // V2 uses tenants/o3energy_mexico/chats
    const snapshot = await db.collection('tenants/o3energy_mexico/chats').orderBy('lastMessageAt', 'desc').get();
    return res.json(snapshot.docs.map((doc: any) => {
      const data = doc.data();
      // Map V2 camelCase back to V1 snake_case for the frontend
      return {
        id: doc.id,
        ...data,
        lastMessageAt: data.lastMessageAt || data.lastMessageAt,
        botDisabled: data.botDisabled || data.botDisabled,
        montoRecibo: data.montoRecibo || data.montoRecibo,
        sistemaEstimado: data.sistemaEstimado || data.sistemaEstimado,
        costoEstimado: data.costoEstimado || data.costoEstimado
      };
    }));
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// Toggle bot
app.post('/api/chats/:phone/toggle-bot', async (req, res) => {
  const { phone } = req.params;
  const { botDisabled } = req.body;
  try {
    const chat = await getChatDoc(phone);
    chat.botDisabled = botDisabled;
    await updateChatDoc(phone, chat);
    return res.json({ success: true, chat });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// Human agent sends manual message
app.post('/api/chats/:phone/message', async (req, res) => {
  const { phone } = req.params;
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text is required' });
  try {
    const chat = await getChatDoc(phone);
    chat.messages.push({ sender: 'agent' as const, text, timestamp: new Date().toISOString() });
    chat.lastMessageAt = new Date().toISOString();
    chat.botDisabled = true;
    await updateChatDoc(phone, chat);
    await sendWhatsAppMessage(phone, text);
    return res.json({ success: true, chat });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// GET leads (Updated for Strangler Pattern to read from V2 location)
app.get('/api/leads', async (_req, res) => {
  try {
    if (isInMemory) return res.json(Object.values(inMemoryLeads));
    // V2 uses tenants/o3energy_mexico/qualified_leads
    const snapshot = await db.collection('tenants/o3energy_mexico/qualified_leads').orderBy('createdAt', 'desc').get();
    return res.json(snapshot.docs.map((doc: any) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        createdAt: data.createdAt || data.createdAt,
        montoRecibo: data.montoRecibo || data.montoRecibo,
        sistemaEstimado: data.sistemaEstimado || data.sistemaEstimado,
        costoEstimado: data.costoEstimado || data.costoEstimado,
        privateNotes: data.privateNotes || data.privateNotes
      };
    }));
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// Copilot query
app.post('/api/copilot/query', async (req, res) => {
  const { question, history } = req.body;
  if (!question) return res.status(400).json({ error: 'Falta la pregunta' });
  try {
    let leadsList: any[] = [], chatsList: any[] = [];
    if (isInMemory) {
      leadsList = Object.values(inMemoryLeads);
      chatsList = Object.values(inMemoryChats).map((c: any) => ({ id: c.id, phone: c.phone, nombre: c.nombre, botDisabled: c.botDisabled, montoRecibo: c.montoRecibo, sistemaEstimado: c.sistemaEstimado, costoEstimado: c.costoEstimado, message_count: c.messages?.length || 0, lastMessageAt: c.lastMessageAt }));
    } else {
      const ls = await db.collection('tenants/o3energy_mexico/qualified_leads').orderBy('createdAt', 'desc').get();
      leadsList = ls.docs.map((d: any) => ({ id: d.id, ...d.data() }));
      const cs = await db.collection('tenants/o3energy_mexico/chats').orderBy('lastMessageAt', 'desc').get();
      chatsList = cs.docs.map((d: any) => { const data = d.data(); return { id: d.id, phone: data.phone, nombre: data.nombre, botDisabled: data.botDisabled, montoRecibo: data.montoRecibo, sistemaEstimado: data.sistemaEstimado, costoEstimado: data.costoEstimado, message_count: data.messages?.length || 0, lastMessageAt: data.lastMessageAt }; });
    }
    const databaseContext = { qualified_leads: leadsList, chats_metadata: chatsList, current_time: new Date().toISOString(), metadata: { total_leads: leadsList.length, total_chats: chatsList.length, pending_leads: leadsList.filter((l: any) => l.status === 'pending_review').length, contacted_leads: leadsList.filter((l: any) => l.status === 'contacted').length } };
    const systemInstruction = `Eres el Copiloto Inteligente de Base de Datos de Ventas de "O3 Energy México". Responde con precisión analítica usando ÚNICAMENTE los datos:\n${JSON.stringify(databaseContext, null, 2)}\nUsa formato Markdown con tablas y negritas. Montos en pesos mexicanos. Si está vacío, sugiere usar el Simulador de Webhook.`;
    try {
      const chatHistory = [
        ...(history || []).map((m: any) => ({
          role: m.sender === 'user' ? 'user' as const : 'assistant' as const,
          content: m.text,
        })),
        { role: 'user' as const, content: question }
      ];
      const answer = await callGroqAPI(systemInstruction, chatHistory, 0.1);
      return res.json({ answer });
    } catch (aiErr: any) {
      console.error('Groq Copilot error:', aiErr);
      return res.status(500).json({ error: aiErr.message || 'Error en el Copiloto' });
    }
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// Mark lead as contacted
app.post('/api/leads/:id/contacted', async (req, res) => {
  const { id } = req.params;
  try {
    if (isInMemory) { if (inMemoryLeads[id]) inMemoryLeads[id].status = 'contacted'; return res.json({ success: true }); }
    await db.collection('tenants/o3energy_mexico/qualified_leads').doc(id).update({ status: 'contacted' });
    return res.json({ success: true });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// Save private notes
app.post('/api/leads/:id/notes', async (req, res) => {
  const { id } = req.params;
  const { privateNotes } = req.body;
  try {
    if (isInMemory) { if (inMemoryLeads[id]) inMemoryLeads[id].privateNotes = privateNotes; return res.json({ success: true, privateNotes }); }
    await db.collection('tenants/o3energy_mexico/qualified_leads').doc(id).set({ privateNotes }, { merge: true });
    return res.json({ success: true, privateNotes });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// Reset demo data
app.post('/api/reset-demo', async (_req, res) => {
  try {
    if (isInMemory) {
      Object.keys(inMemoryChats).forEach(k => delete inMemoryChats[k]);
      Object.keys(inMemoryLeads).forEach(k => delete inMemoryLeads[k]);
    } else {
      const chatsSnap = await db.collection('tenants/o3energy_mexico/chats').get();
      for (const doc of chatsSnap.docs) await doc.ref.delete();
      const leadsSnap = await db.collection('tenants/o3energy_mexico/qualified_leads').get();
      for (const doc of leadsSnap.docs) await doc.ref.delete();
    }
    return res.json({ success: true, message: 'Datos reseteados.' });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// Export the Express app as the Vercel serverless handler
export default app;

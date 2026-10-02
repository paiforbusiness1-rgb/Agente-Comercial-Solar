/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import nodemailer from 'nodemailer';
import fs from 'fs';
import firebaseConfig from './firebase-applet-config.json';
import { buildReceiveMessageUseCase, initRepositories } from './server/infrastructure/web/container.js';
import { v2Router } from './server/infrastructure/web/v2Router.js';

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- FIREBASE ADMINISTRATION INITIALIZATION ---
let db: any = null;
let isInMemory = false;

// Fallback in-memory DB in case Firestore experiences configuration or local preview restrictions
const inMemoryChats: Record<string, any> = {};
const inMemoryLeads: Record<string, any> = {};

try {
  const serviceAccountPath = path.join(process.cwd(), 'firebase-service-account.json');
  const hasServiceAccount = fs.existsSync(serviceAccountPath);
  const hasEnvCredentials = !!process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (hasServiceAccount || hasEnvCredentials) {
    if (hasServiceAccount) {
      initializeApp({
        credential: cert(serviceAccountPath),
        projectId: firebaseConfig.projectId,
      });
      console.log('Firebase Admin SDK initialized using firebase-service-account.json');
    } else {
      initializeApp({
        projectId: firebaseConfig.projectId,
      });
      console.log('Firebase Admin SDK initialized using GOOGLE_APPLICATION_CREDENTIALS');
    }
    
    // Connect to the specific database ID or fall back to standard
    const dbId = firebaseConfig.firestoreDatabaseId;
    db = dbId && dbId !== '(default)'
      ? getFirestore(dbId)
      : getFirestore();
    
    console.log(`Firebase Admin SDK connected successfully. Database ID: ${dbId || '(default)'}`);
  } else {
    console.warn('No Firebase credentials found (firebase-service-account.json or GOOGLE_APPLICATION_CREDENTIALS missing). Falling back to in-memory mode.');
    isInMemory = true;
  }
} catch (error) {
  console.warn('Firebase Admin SDK failed to initialize. Falling back to in-memory mode:', error);
  isInMemory = true;
}

// Wire the clean-architecture container to the same Firebase state
initRepositories(db);

// Mount v2 Router (Clean Architecture / Tool Calling)
app.use('/api/v2', v2Router);

// Helper to access chats collection
async function getChatDoc(phone: string): Promise<any> {
  if (isInMemory) {
    if (!inMemoryChats[phone]) {
      inMemoryChats[phone] = {
        id: phone,
        phone,
        nombre: 'Cliente',
        bot_disabled: false,
        messages: [],
        last_message_at: new Date().toISOString(),
      };
    }
    return inMemoryChats[phone];
  } else {
    const docRef = db.collection('chats').doc(phone);
    const doc = await docRef.get();
    if (!doc.exists) {
      const newChat = {
        phone,
        nombre: 'Cliente',
        bot_disabled: false,
        messages: [],
        last_message_at: new Date().toISOString(),
      };
      await docRef.set(newChat);
      return { id: phone, ...newChat };
    }
    return { id: doc.id, ...doc.data() };
  }
}

async function updateChatDoc(phone: string, data: any): Promise<void> {
  if (isInMemory) {
    inMemoryChats[phone] = { ...inMemoryChats[phone], ...data };
  } else {
    await db.collection('chats').doc(phone).set(data, { merge: true });
  }
}

async function createQualifiedLead(lead: any): Promise<void> {
  const leadId = lead.id || `lead_${Date.now()}`;
  if (isInMemory) {
    inMemoryLeads[leadId] = {
      ...lead,
      id: leadId,
      status: 'pending_review',
      created_at: new Date().toISOString(),
    };
  } else {
    await db.collection('qualified_leads').doc(leadId).set({
      ...lead,
      status: 'pending_review',
      created_at: new Date().toISOString(),
    });
  }
}

async function sendSalesEmailNotification(lead: any, phone: string): Promise<boolean> {
  const senderEmail = process.env.SENDER_EMAIL || 'alertas@o3energy.mx';
  const senderPassword = process.env.SENDER_PASSWORD;
  const salesEmail = process.env.SALES_EMAIL || 'ventas@o3energy.mx';
  const smtpServer = process.env.SMTP_SERVER || 'smtp.gmail.com';
  const smtpPort = parseInt(process.env.SMTP_PORT || '587');

  const subject = `🔥 Nuevo Lead Calificado: ${lead.nombre || 'Cliente'} (${lead.monto_recibo || 'Sin monto'})`;
  const bodyHtml = `
    <div style="font-family: sans-serif; max-width: 600px; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); margin: 0 auto;">
      <div style="background-color: #ea580c; color: white; padding: 24px; text-align: center;">
        <h1 style="margin: 0; font-size: 20px;">🔥 ¡Nuevo Lead Calificado Detectado!</h1>
        <p style="margin: 4px 0 0 0; font-size: 14px; opacity: 0.9;">O3 Energy Sales Automation AI</p>
      </div>
      <div style="padding: 24px; color: #334155;">
        <p>Se ha calificado de forma totalmente autónoma un nuevo interesado en sistemas solares:</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 0; font-weight: bold; color: #64748b; width: 180px;">Nombre del Cliente:</td>
            <td style="padding: 10px 0; color: #0f172a; font-weight: 600;">${lead.nombre}</td>
          </tr>
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 0; font-weight: bold; color: #64748b;">WhatsApp (Teléfono):</td>
            <td style="padding: 10px 0; color: #0f172a; font-family: monospace;">+${phone}</td>
          </tr>
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 0; font-weight: bold; color: #64748b;">Gasto Promedio CFE:</td>
            <td style="padding: 10px 0; color: #ea580c; font-weight: bold;">${lead.monto_recibo}</td>
          </tr>
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 0; font-weight: bold; color: #64748b;">Sistema Propuesto:</td>
            <td style="padding: 10px 0; color: #0f172a;">${lead.sistema_estimado}</td>
          </tr>
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 0; font-weight: bold; color: #64748b;">Presupuesto Estimado:</td>
            <td style="padding: 10px 0; color: #ea580c; font-weight: bold;">${lead.costo_estimado}</td>
          </tr>
        </table>
        
        <div style="text-align: center; margin-top: 28px; margin-bottom: 16px;">
          <a href="https://wa.me/${phone}" style="background-color: #ea580c; color: white; padding: 12px 24px; border-radius: 12px; text-decoration: none; font-weight: bold; display: inline-block;">
            💬 Atender de inmediato en WhatsApp
          </a>
        </div>
      </div>
      <div style="background-color: #f8fafc; padding: 16px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #f1f5f9;">
        Este es un mensaje automatizado generado por el bot de Inteligencia Artificial de O3 Energy México.
      </div>
    </div>
  `;

  if (!process.env.SENDER_EMAIL || !process.env.SENDER_PASSWORD) {
    console.log(`\n======================================================`);
    console.log(`[SMTP SIMULACIÓN] Se detectó un nuevo lead calificado.`);
    console.log(`[SMTP SIMULACIÓN] Destinatario: ${salesEmail}`);
    console.log(`[SMTP SIMULACIÓN] Asunto: ${subject}`);
    console.log(`[SMTP SIMULACIÓN] (Para envíos reales, configure SENDER_EMAIL y SENDER_PASSWORD en Configuración)`);
    console.log(`======================================================\n`);
    return true;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtpServer,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: senderEmail,
        pass: senderPassword,
      },
    });

    const info = await transporter.sendMail({
      from: `"Alertas O3 Energy AI" <${senderEmail}>`,
      to: salesEmail,
      subject: subject,
      html: bodyHtml,
    });

    console.log(`[SMTP EXITO] Correo de notificación enviado con ID: ${info.messageId}`);
    return true;
  } catch (err) {
    console.error(`[SMTP ERROR] Error enviando correo de notificación:`, err);
    return false;
  }
}

// --- SEND REAL WHATSAPP MESSAGE VIA META CLOUD API ---
async function sendWhatsAppMessage(phone: string, text: string): Promise<boolean> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.log(`\n======================================================`);
    console.log(`[WHATSAPP SIMULACIÓN] Enviando mensaje a +${phone}`);
    console.log(`[WHATSAPP SIMULACIÓN] Texto: ${text}`);
    console.log(`[WHATSAPP SIMULACIÓN] (Para envíos reales, configure WHATSAPP_ACCESS_TOKEN y WHATSAPP_PHONE_NUMBER_ID en .env)`);
    console.log(`======================================================\n`);
    return true;
  }

  try {
    const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'text',
        text: {
          preview_url: false,
          body: text,
        },
      }),
    });

    const data = await response.json();
    if (response.ok) {
      console.log(`[WHATSAPP EXITO] Mensaje enviado a +${phone}. Message ID: ${data.messages?.[0]?.id}`);
      return true;
    } else {
      console.error(`[WHATSAPP ERROR] Fallo al enviar mensaje a +${phone}:`, data);
      return false;
    }
  } catch (err) {
    console.error(`[WHATSAPP EXCEPCION] Error al enviar mensaje de WhatsApp:`, err);
    return false;
  }
}

// --- LLM PROVIDER (Groq primario + Gemini fallback) ---
import { callLLM } from './server/infrastructure/ai/LLMProvider.js';
async function callGroqAPI(
  systemInstruction: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  temperature: number = 0.7
): Promise<string> {
  const result = await callLLM(systemInstruction, messages, temperature);
  return result.text;
}

// --- O3 ENERGY ASSISTANT PROMPT ---
const SYSTEM_INSTRUCTION = `
Eres SOFÍA, una asesora de ventas experta, cálida y profesional de "O3 Energy México", empresa líder en ingeniería de energía solar con más de 15 años de experiencia, instalando sistemas fotovoltaicos de alta calidad para hogares y comercios en Chihuahua y todo México.

Tu misión es guiar a los prospectos a través de un proceso de ventas consultivo: diagnosticar su situación, resolver sus dudas, explicar las opciones de pago y agendar la visita técnica gratuita. Siempre en español de México, con un tono amigable, experto y de confianza.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 FASE 1 — BIENVENIDA Y DIAGNÓSTICO CFE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Cuando el usuario inicie el chat:
1. Salúdalo calurosamente e identifícate como Sofía de O3 Energy México.
2. Pregunta su nombre de forma natural.
3. Pregunta cuánto paga aproximadamente en su recibo de luz de CFE (al mes o bimestre, en pesos mexicanos).
4. Pregunta sutilmente si es el titular del recibo o el dueño de la propiedad donde se instalarían los paneles (es requisito para la tramitación).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟡 FASE 2 — ENCUESTA TÉCNICA DE VIABILIDAD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Antes de dar una cotización, recopila información técnica básica haciendo estas preguntas de forma conversacional y natural (no como un formulario frío). Puedes agrupar 2 preguntas por mensaje para agilizar:

- ¿Su propiedad tiene 1 o 2 plantas?
- ¿De qué material es su techo? (Losa de concreto, lámina, teja, otro)
- ¿Tiene espacio libre de sombras y obstáculos en el techo?
- ¿Tiene pensado agregar aparatos de alto consumo próximamente? (Ej. minisplits, calentador de agua eléctrico, etc.) — esto es importante para dimensionar el sistema correctamente.
- ¿Su medidor eléctrico es de 110V o 220V?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟢 FASE 3 — COTIZACIÓN PRELIMINAR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REGLA OBLIGATORIA: Solo aplica si el gasto del cliente es > $2,500 MXN mensuales o bimestrales.
Si el cliente da su gasto mensual, MULTIPLÍCALO POR 2 para encontrar su rango en la tabla bimestral.
Si el cliente da su gasto bimestral, búscalo directamente en la tabla.

Tabla estricta de cotización (ESTÁ ESTRICTAMENTE PROHIBIDO INVENTAR NÚMEROS FUERA DE ESTA TABLA):
- De $2,500 a $4,000 MXN bimestre → 4 a 6 paneles → ~$70,000 a $90,000 MXN → ROI ~3 años
- De $4,000 a $6,000 MXN bimestre → 6 a 8 paneles → ~$90,000 a $120,000 MXN → ROI ~3 a 4 años
- De $6,000 a $10,000 MXN bimestre → 8 a 12 paneles → ~$120,000 a $180,000 MXN → ROI ~3 a 4 años
- Más de $10,000 MXN bimestre → Sistema comercial de 12+ paneles, requiere análisis personalizado

REGLA DE ORO CONTRA ALUCINACIONES (¡CRÍTICO!):
NUNCA inventes una cantidad de paneles o kWp que no esté explícitamente en el rango de la tabla. 
Por ejemplo, si el cliente paga $6,000 bimestrales, le corresponden DE 8 a 12 PANELES. ¡NUNCA digas 55 paneles ni ningún otro número loco! 
PROHIBIDO hacer cálculos matemáticos propios sobre potencia (kWp) o inversión; limítate a leer la tabla y decir el rango de paneles y el rango de precios correspondientes. 
Si el usuario corrige diciendo que su gasto era bimestral y no mensual (ej. 6,000 bimestral en vez de 6,000 mensual), simplemente lee la tabla de nuevo para "De $6,000 a $10,000 MXN bimestre".

Adapta proporcionalmente dentro de la tabla. El sistema puede generar hasta un 95% de ahorro en el recibo de CFE.

SIEMPRE incluye textualmente esta aclaración al final de la cotización:
"📋 Este es un presupuesto preliminar de arranque. La cotización definitiva se determina en nuestra visita técnica SIN COSTO en tu propiedad, donde evaluamos inclinación del techo, sombras y trayectoria eléctrica."

Lo que INCLUYE el servicio de O3 Energy México (puedes mencionarlo si el cliente pregunta):
✅ Visita técnica y evaluación sin costo
✅ Suministro de equipos Tier 1 de alta eficiencia
✅ Instalación profesional certificada
✅ Pruebas y puesta en marcha
✅ Capacitación en el uso del sistema
✅ Trámite de interconexión ante CFE (incluido)
✅ App de monitoreo en tiempo real (sin costo)
✅ Garantía por escrito en equipos e instalación

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💳 FASE 4 — OPCIONES DE PAGO Y FINANCIAMIENTO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Después de la cotización, presenta las opciones de pago de forma proactiva. Si el cliente pregunta por precio o menciona que es mucho, explica:

OPCIÓN A — CONTADO:
• 50% de anticipo al firmar el contrato
• 50% restante el día de la instalación

OPCIÓN B — FINANCIAMIENTO (con financiera local):
• Solo 10% de anticipo (o más, según tu capacidad)
• 4% de interés mensual sobre saldos insolutos
• Ventaja importante: puedes abonar a capital o liquidar anticipadamente SIN penalización
• Plazos disponibles: 12, 24 o 36 meses (dependiendo del monto)
• Todos nuestros clientes aplican al financiamiento

Requisitos básicos para el financiamiento (si el cliente los pide):
- INE vigente
- Comprobante de domicilio
- Contrato de arrendamiento o escrituras / predial
- 3 estados de cuenta bancarios
- Constancia de situación fiscal

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 FASE 5 — BASE DE CONOCIMIENTO (PREGUNTAS FRECUENTES)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Responde con naturalidad cuando el cliente haga estas preguntas:

❓ "¿Ya empiezo a ahorrar desde el día de la instalación?"
→ Sí, desde el momento en que entra en operación el sistema comienza a generar energía. Los beneficios completos se reflejan una vez que CFE completa el proceso de interconexión y cambia al medidor bidireccional (esto toma entre 4 y 12 semanas después de la instalación).

❓ "¿Por qué seguiré recibiendo recibos de CFE?"
→ Porque continuarás pagando los cargos mínimos de conexión, o el consumo que exceda lo que genera tu sistema. En muchos casos el recibo baja hasta un 95%.

❓ "¿Qué pasa si se va la luz?"
→ Por seguridad, el sistema también deja de funcionar mientras no hay red eléctrica (esto se llama protección anti-isla). Si deseas energía durante apagones, existe la opción de agregar baterías de respaldo.

❓ "¿Los paneles funcionan en días nublados?"
→ Sí, los paneles siguen generando energía en días nublados, aunque en menor cantidad que en días soleados. Chihuahua tiene uno de los índices de irradiación solar más altos del país, así que eso nos favorece mucho.

❓ "¿Necesito limpiarlos?"
→ Sí, recomendamos una limpieza cada 4 a 6 meses, o cuando notes acumulación importante de polvo, tierra o excremento de aves.

❓ "¿Puedo instalar más paneles después?"
→ En la mayoría de los casos sí es posible ampliar el sistema. Lo evaluamos en la visita técnica.

❓ "¿Qué garantía tienen?"
→ Los equipos cuentan con garantía de fabricante y la instalación tiene garantía por escrito proporcionada directamente por O3 Energy México.

❓ "¿Tienen programa de referidos?"
→ ¡Sí! Si conoces a alguien interesado en ahorrar con energía solar, pregunta por nuestro programa de recomendaciones y obtén beneficios por cada proyecto referido que se concrete.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔔 SEGUIMIENTO PROACTIVO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Si el cliente no ha respondido después de que enviaste información, puedes cerrar con un mensaje amable de seguimiento como:
"Quedo a tus órdenes, cualquier duda con gusto te atiendo. 😊"
o
"¿Pudiste revisar la información? Si tienes alguna pregunta, aquí estamos para ayudarte."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ REGLA DE SALIDA — GENERACIÓN DE LEAD CALIFICADO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Cuando hayas recopilado: (1) el nombre, (2) el monto del recibo, (3) la confirmación de ser propietario o interesado, y (4) hayas presentado la cotización preliminar, DEBES colocar OBLIGATORIAMENTE al final absoluto de tu mensaje el siguiente bloque JSON exactamente con este formato:

[QUALIFIED_LEAD: {"nombre": "Nombre del cliente", "monto_recibo": "$X,XXX MXN", "sistema_estimado": "X paneles", "costo_estimado": "$XX,XXX MXN"}]

REGLAS CRÍTICAS para este bloque:
- Nunca lo menciones ni lo expliques al cliente en la conversación.
- Colócalo SIEMPRE al final del mensaje, después de toda la respuesta visible.
- Solo inclúyelo UNA VEZ, cuando ya tengas todos los datos necesarios.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 REGLAS GENERALES DE COMUNICACIÓN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Respuestas cortas y fáciles de leer en WhatsApp.
- Usa emojis con moderación para dar calidez (no en exceso).
- Usa saltos de línea y viñetas para organizar la información.
- No hagas todas las preguntas de golpe; distribúyelas de forma conversacional.
- Si el gasto es menor a $2,500 MXN o el cliente NO es propietario, explícale amablemente por qué no aplica aún y ofrécele agendar para cuando su situación cambie.
- Nunca inventes precios ni garantices cifras que no se hayan calculado en base a los datos del cliente.
`;

// Helper to extract lead from Gemini response
function extractQualifiedLead(text: string): { cleanText: string; leadData: any | null } {
  // Matches [QUALIFIED_LEAD: { ... }]
  const match = text.match(/\[QUALIFIED_LEAD:\s*(\{.*?\})\s*\]/s);
  if (match) {
    try {
      const jsonStr = match[1].trim();
      const leadData = JSON.parse(jsonStr);
      const cleanText = text.replace(match[0], '').trim();
      return { cleanText, leadData };
    } catch (e) {
      console.error('Error parsing lead JSON tag from Gemini:', e);
    }
  }
  return { cleanText: text, leadData: null };
}

// --- API ENDPOINTS ---

// Webhook validation for Meta (GET)
app.get(['/whatsapp-webhook', '/api/whatsapp-webhook'], (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'O3_ENERGY_MEXICO_TOKEN';

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified successfully!');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  return res.status(200).send('O3 Energy Webhook Service Active. Please send a POST request.');
});

// Incoming Webhook (POST) - Supports Meta Cloud, Twilio and Custom formats
// Uses LLMOrchestrator + SolarQuoteEngine (Tool Calling) — same as Vercel/api/index.js
app.post(['/whatsapp-webhook', '/api/whatsapp-webhook'], async (req, res) => {
  let phone = '';
  let text = '';
  let name = 'Cliente';

  const body = req.body;

  // 1. Meta / Facebook Cloud API Payload
  if (body.entry?.[0]?.changes?.[0]?.value) {
    const val = body.entry[0].changes[0].value;
    if (val.messages?.[0]) {
      const msg = val.messages[0];
      phone = msg.from;
      text = msg.text?.body || msg.button?.text || '';
      name = val.contacts?.[0]?.profile?.name || 'Cliente WhatsApp';
    } else {
      // Status update — ack and ignore
      return res.status(200).json({ status: 'received' });
    }
  }
  // 2. Twilio Webhook Form/JSON Payload
  else if (body.From && body.Body) {
    phone = body.From.replace('whatsapp:', '');
    text = body.Body;
    name = body.ProfileName || 'Cliente Twilio';
  }
  // 3. Custom / Playground / Simulator Payload
  else if (body.phone && body.text) {
    phone = body.phone;
    text = body.text;
    name = body.name || 'Cliente Simulado';
  }

  if (!phone || !text) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos (teléfono o texto)' });
  }

  phone = phone.replace(/[^\d]/g, '');

  try {
    // Check bot-disabled flag via legacy store first
    const chatData = await getChatDoc(phone);
    if (chatData.bot_disabled) {
      // Save the incoming message but don't reply with AI
      const userMessage = { sender: 'user' as const, text, timestamp: new Date().toISOString() };
      chatData.messages = [...(chatData.messages || []), userMessage];
      chatData.last_message_at = new Date().toISOString();
      await updateChatDoc(phone, chatData);
      return res.status(200).json({ status: 'received', message: 'Bot disabled. Handled manually.', chat: chatData });
    }

    // ── Delegate to the clean-architecture use case (Tool Calling enabled) ──
    const useCase = buildReceiveMessageUseCase();
    const result = await useCase.execute({ phone, text, name, tenantId: 'o3energy_mexico' });

    // Read back the saved conversation to mirror into the legacy flat-chat store for the UI
    const savedChat = await getChatDoc(phone);

    return res.status(200).json({
      status: 'success',
      reply: result.reply,
      lead_generated: result.leadGenerated,
      chat: savedChat,
    });

  } catch (err: any) {
    console.error('[Webhook] Error processing message:', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET active chats
app.get('/api/chats', async (req, res) => {
  try {
    if (isInMemory) {
      return res.json(Object.values(inMemoryChats));
    } else {
      const snapshot = await db.collection('chats').orderBy('last_message_at', 'desc').get();
      const chatsList = snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
      return res.json(chatsList);
    }
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST to manually send a message or simulate bot toggle
app.post('/api/chats/:phone/toggle-bot', async (req, res) => {
  const { phone } = req.params;
  const { bot_disabled } = req.body;
  try {
    const chat = await getChatDoc(phone);
    chat.bot_disabled = bot_disabled;
    await updateChatDoc(phone, chat);
    return res.json({ success: true, chat });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST human agent message
app.post('/api/chats/:phone/message', async (req, res) => {
  const { phone } = req.params;
  const { text } = req.body;
  
  if (!text) {
    return res.status(400).json({ error: 'Text is required' });
  }

  try {
    const chat = await getChatDoc(phone);
    
    const agentMsg = {
      sender: 'agent' as const,
      text,
      timestamp: new Date().toISOString()
    };
    
    chat.messages.push(agentMsg);
    chat.last_message_at = new Date().toISOString();
    // Automatically mute bot if human steps in, to avoid collision
    chat.bot_disabled = true;

    await updateChatDoc(phone, chat);

    // Send the manual message physically to the user's WhatsApp if credentials are configured
    await sendWhatsAppMessage(phone, text);

    return res.json({ success: true, chat });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET qualified leads
app.get('/api/leads', async (req, res) => {
  try {
    if (isInMemory) {
      return res.json(Object.values(inMemoryLeads));
    } else {
      const snapshot = await db.collection('qualified_leads').orderBy('created_at', 'desc').get();
      const leadsList = snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
      return res.json(leadsList);
    }
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST copilot query - database analysis chatbot
app.post('/api/copilot/query', async (req, res) => {
  const { question, history } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'Falta la pregunta del usuario' });
  }

  try {
    // 1. Fetch current database data
    let leadsList: any[] = [];
    let chatsList: any[] = [];

    if (isInMemory) {
      leadsList = Object.values(inMemoryLeads);
      chatsList = Object.values(inMemoryChats).map((chat: any) => ({
        id: chat.id,
        phone: chat.phone,
        nombre: chat.nombre,
        bot_disabled: chat.bot_disabled,
        monto_recibo: chat.monto_recibo,
        sistema_estimado: chat.sistema_estimado,
        costo_estimado: chat.costo_estimado,
        message_count: chat.messages ? chat.messages.length : 0,
        last_message_at: chat.last_message_at
      }));
    } else {
      const leadsSnap = await db.collection('qualified_leads').orderBy('created_at', 'desc').get();
      leadsList = leadsSnap.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));

      const chatsSnap = await db.collection('chats').orderBy('last_message_at', 'desc').get();
      chatsList = chatsSnap.docs.map((doc: any) => {
        const data = doc.data();
        return {
          id: doc.id,
          phone: data.phone,
          nombre: data.nombre,
          bot_disabled: data.bot_disabled,
          monto_recibo: data.monto_recibo,
          sistema_estimado: data.sistema_estimado,
          costo_estimado: data.costo_estimado,
          message_count: data.messages ? data.messages.length : 0,
          last_message_at: data.last_message_at
        };
      });
    }

    // 2. Build the context for Groq
    const databaseContext = {
      qualified_leads: leadsList,
      chats_metadata: chatsList,
      current_time: new Date().toISOString(),
      metadata: {
        total_leads: leadsList.length,
        total_chats: chatsList.length,
        pending_leads: leadsList.filter((l: any) => l.status === 'pending_review').length,
        contacted_leads: leadsList.filter((l: any) => l.status === 'contacted').length,
      }
    };

    // 3. Set up system instruction with raw database data
    const systemInstruction = `
Eres el Copiloto Inteligente de Base de Datos de Ventas de "O3 Energy México". Tu objetivo es asistir al equipo interno de ventas y administración a buscar, filtrar, calcular, resumir y analizar los leads calificados e historiales de chats que se van alimentando en tiempo real.

Tienes acceso completo e inmediato a los siguientes datos estructurados del sistema en formato JSON:
${JSON.stringify(databaseContext, null, 2)}

Instrucciones para tus respuestas:
1. Responde con precisión analítica, basándote ÚNICAMENTE en los datos estructurados provistos arriba.
2. Si te preguntan totales de prospectos, sumas de dinero (pipeline de ventas de leads calificados o contactados), conversiones, o promedios, haz las operaciones matemáticas correctas y explica detalladamente tu cálculo.
3. Si el usuario te pregunta por un prospecto o cliente en particular por su nombre o teléfono, búscalo en "qualified_leads" o "chats_metadata" y dale un resumen detallado de sus características.
4. Siempre que menciones montos de dinero, dales el formato elegante de pesos mexicanos (ej. $15,000 MXN).
5. Usa formato Markdown de forma abundante y organizada para estructurar tus respuestas (tablas, listas, negritas, bloques de código, etc.) para que sean muy fáciles de leer y profesionales.
6. Si la base de datos está vacía, indícalo amablemente y sugiéreles usar el Simulador del Webhook de WhatsApp para generar leads de prueba de forma interactiva.
7. Mantén siempre un tono profesional, servicial, motivador y sumamente claro.
`;

    // 4. Structure conversation history for Groq
    const chatHistory: { role: 'user' | 'assistant'; content: string }[] = [];
    if (history && Array.isArray(history)) {
      history.forEach((msg: any) => {
        chatHistory.push({
          role: msg.sender === 'user' ? 'user' : 'assistant',
          content: msg.text,
        });
      });
    }
    chatHistory.push({ role: 'user', content: question });

    const answer = await callGroqAPI(systemInstruction, chatHistory, 0.1);
    return res.json({ answer });

  } catch (err: any) {
    console.error('Error in Copilot query API:', err);
    return res.status(500).json({ error: err.message || 'Error interno del servidor en el chatbot copiloto.' });
  }
});

// Delete lead / mock endpoints for demo purposes
app.post('/api/leads/:id/contacted', async (req, res) => {
  const { id } = req.params;
  try {
    if (isInMemory) {
      if (inMemoryLeads[id]) {
        inMemoryLeads[id].status = 'contacted';
      }
      return res.json({ success: true });
    } else {
      await db.collection('qualified_leads').doc(id).update({ status: 'contacted' });
      return res.json({ success: true });
    }
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Update private notes for follow-up tracking
app.post('/api/leads/:id/notes', async (req, res) => {
  const { id } = req.params;
  const { private_notes } = req.body;
  try {
    if (isInMemory) {
      if (inMemoryLeads[id]) {
        inMemoryLeads[id].private_notes = private_notes;
      }
      return res.json({ success: true, private_notes });
    } else {
      await db.collection('qualified_leads').doc(id).set({ private_notes }, { merge: true });
      return res.json({ success: true, private_notes });
    }
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Clear all database entries (useful for resetting the playground in one-click)
app.post('/api/reset-demo', async (req, res) => {
  try {
    if (isInMemory) {
      Object.keys(inMemoryChats).forEach(k => delete inMemoryChats[k]);
      Object.keys(inMemoryLeads).forEach(k => delete inMemoryLeads[k]);
    } else {
      // Clear Firestore collections
      const chatsSnap = await db.collection('chats').get();
      for (const doc of chatsSnap.docs) {
        await doc.ref.delete();
      }
      const leadsSnap = await db.collection('qualified_leads').get();
      for (const doc of leadsSnap.docs) {
        await doc.ref.delete();
      }
    }
    return res.json({ success: true, message: 'Playground database reset successfully.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// --- VITE DEV AND PROD ROUTING ---
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server executing successfully on http://localhost:${PORT}`);
  });
}

startServer();

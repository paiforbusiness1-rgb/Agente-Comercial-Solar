import 'dotenv/config';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as fs from 'fs';

async function sanitizeHectorChatApo026() {
  const files = fs.readdirSync('.');
  const serviceAccountFile = files.find(f => f.startsWith('agente-comercial-solar-firebase-adminsdk-') && f.endsWith('.json'));
  if (!serviceAccountFile) {
    console.error('No service account found');
    process.exit(1);
  }
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountFile, 'utf-8'));
  if (!getApps().length) initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore();
  const phone = '5214777241148';
  const tenantId = 'o3energy_mexico';

  console.log(`=== SANEAMIENTO FORENSE APO-026 EN FIRESTORE ===`);
  console.log(`Colección: tenants/${tenantId}/chats | Documento: ${phone}\n`);

  const docRef = db.collection(`tenants/${tenantId}/chats`).doc(phone);
  const doc = await docRef.get();
  if (!doc.exists) {
    console.error(`Documento ${phone} no existe.`);
    process.exit(1);
  }

  const data = doc.data() as any;
  let messages = data.messages || [];
  console.log(`Total mensajes antes del saneamiento: ${messages.length}`);

  // Encontrar el mensaje donde Sofía entrega la cotización y pregunta sobre financiamiento/visita
  const quoteIndex = messages.findIndex((m: any) => 
    m.sender === 'bot' && m.text.includes('¿Te gustaría conocer nuestras opciones de financiamiento con pagos mensuales accesibles o prefieres agendar una visita técnica')
  );

  if (quoteIndex !== -1) {
    // Truncar exactamente al mensaje de entrega de cotización (dejándolo como el último mensaje)
    messages = messages.slice(0, quoteIndex + 1);
    console.log(`✅ Historial truncado en la cotización entregada (índice ${quoteIndex + 1} mensajes).`);
  } else {
    console.warn('⚠️ No se encontró la frase exacta de cotización; verificando mensajes.');
  }

  data.messages = messages;
  data.state = data.state || {};
  data.state.phase = 'QUOTATION';
  data.state.completedSteps = ['ROOF_CONFIRMED', 'SHADOWS_ASSESSED', 'QUOTE_SENT'];
  data.state.quoteConsentRequested = true;
  data.state.quoteConsentGiven = true;
  data.state.financingConsentRequested = false;
  data.state.financingConsentGiven = false;
  data.botDisabled = false;

  const lastMsg = messages[messages.length - 1];
  if (lastMsg) {
    data.lastMessageAt = lastMsg.timestamp;
  }

  await docRef.set(data);
  console.log(`✅ Documento actualizado exitosamente en Firestore.`);

  // Verificación post-saneamiento
  const postDoc = await docRef.get();
  const postData = postDoc.data() as any;
  const postMessages = postData.messages || [];
  const finalMsg = postMessages[postMessages.length - 1];

  console.log(`\n--- VERIFICACIÓN POST-SANEAMIENTO APO-026 ---`);
  console.log(`Total mensajes: ${postMessages.length}`);
  console.log(`Último mensaje (${finalMsg?.sender}): "${finalMsg?.text?.substring(0, 100)}..."`);
  console.log(`Phase: ${postData.state?.phase}`);
  console.log(`CompletedSteps: ${JSON.stringify(postData.state?.completedSteps)}`);
  console.log(`FinancingConsentRequested: ${postData.state?.financingConsentRequested}`);
  console.log(`BotDisabled: ${postData.botDisabled}`);
  console.log(`=== SANEAMIENTO APO-026 COMPLETADO CON ÉXITO ===`);
  process.exit(0);
}

sanitizeHectorChatApo026().catch(err => {
  console.error('Error durante saneamiento:', err);
  process.exit(1);
});

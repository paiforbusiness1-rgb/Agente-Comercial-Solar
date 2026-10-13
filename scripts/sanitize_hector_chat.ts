import 'dotenv/config';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as fs from 'fs';

async function sanitizeHectorChat() {
  const files = fs.readdirSync('.');
  const serviceAccountFile = files.find(f => f.startsWith('agente-comercial-solar-firebase-adminsdk-') && f.endsWith('.json'));
  if (!serviceAccountFile) {
    console.error('No service account file found');
    process.exit(1);
  }
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountFile, 'utf-8'));
  
  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }
  const db = getFirestore();
  const phone = '5214777241148';
  const tenantId = 'o3energy_mexico';

  console.log(`=== SANEAMIENTO FORENSE PRE-DESPLIEGUE EN FIRESTORE ===`);
  console.log(`Colección: tenants/${tenantId}/chats | Documento: ${phone}\n`);

  const docRef = db.collection(`tenants/${tenantId}/chats`).doc(phone);
  const doc = await docRef.get();
  if (!doc.exists) {
    console.error(`Documento ${phone} no existe.`);
    process.exit(1);
  }

  const data = doc.data() as any;
  let messages = data.messages || [];

  console.log(`Total de mensajes antes del saneamiento: ${messages.length}`);

  // Encontrar el índice del mensaje donde Sofía ofrece el brochure de financiamiento
  const financingOfferIndex = messages.findIndex((m: any) => 
    m.sender === 'bot' && m.text.includes('¿Te gustaría que te envíe el brochure oficial con los requisitos y pasos para tramitar el financiamiento?')
  );

  if (financingOfferIndex !== -1) {
    // Truncar exactamente al mensaje de oferta de financiamiento (incluyéndolo como el último mensaje)
    messages = messages.slice(0, financingOfferIndex + 1);
    console.log(`✅ Historial truncado exactamente en el ofrecimiento de financiamiento (índice ${financingOfferIndex + 1}).`);
  } else {
    console.warn('⚠️ No se encontró la frase exacta de financiamiento; verificando mensajes finales.');
  }

  data.messages = messages;
  data.state = data.state || {};
  data.state.phase = 'FINANCING';
  data.state.financingConsentRequested = true;
  data.state.financingConsentGiven = false;
  data.state.mediaSentFlags = data.state.mediaSentFlags || {};
  data.state.mediaSentFlags.financiamiento = false;
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

  console.log(`\n--- VERIFICACIÓN POST-SANEAMIENTO ---`);
  console.log(`Total mensajes: ${postMessages.length}`);
  console.log(`Último mensaje (${finalMsg?.sender}): "${finalMsg?.text.substring(0, 100)}..."`);
  console.log(`Phase: ${postData.state.phase}`);
  console.log(`FinancingConsentRequested: ${postData.state.financingConsentRequested}`);
  console.log(`FinancingConsentGiven: ${postData.state.financingConsentGiven}`);
  console.log(`MediaSentFlags.financiamiento: ${postData.state.mediaSentFlags?.financiamiento}`);
  console.log(`BotDisabled: ${postData.botDisabled}`);
  console.log(`=== SANEAMIENTO COMPLETADO CON ÉXITO ===`);
}

sanitizeHectorChat().catch((err) => {
  console.error('Error durante el saneamiento:', err);
  process.exit(1);
});

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

  console.log(`Mensajes actuales (${messages.length}):`);
  messages.forEach((m: any, idx: number) => {
    console.log(`[${idx}] ${m.sender}: ${m.text?.substring(0, 80)}`);
  });

  // Encontrar si hay mensaje de intermitencia técnica
  const intermitenciaIndex = messages.findIndex((m: any) => 
    m.sender === 'bot' && m.text.includes('intermitencia técnica')
  );

  if (intermitenciaIndex !== -1) {
    // Truncar antes del mensaje del usuario que provocó el fallo (ej. "te comparto los recibos aguarda!")
    const truncateAt = Math.max(0, intermitenciaIndex - 1);
    messages = messages.slice(0, truncateAt);
    console.log(`✅ Historial truncado eliminando el turno fallido (truncado a índice ${truncateAt}).`);
  } else {
    // Si no hay intermitencia, verificar si el último es bot en QUALIFICATION
    console.log(`ℹ️ No se detectó mensaje de intermitencia.`);
  }

  data.messages = messages;
  data.nombre = 'Héctor';
  data.state = data.state || {};
  data.state.phase = 'QUALIFICATION';
  data.state.clientName = 'Héctor';
  data.state.mediaSentFlags = data.state.mediaSentFlags || {};
  data.state.mediaSentFlags.instalacionProfessional = true;
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
  console.log(`Último mensaje (${finalMsg?.sender}): "${finalMsg?.text?.substring(0, 100)}..."`);
  console.log(`Phase: ${postData.state?.phase}`);
  console.log(`ClientName: ${postData.nombre}`);
  console.log(`BotDisabled: ${postData.botDisabled}`);
  console.log(`=== SANEAMIENTO COMPLETADO CON ÉXITO ===`);
  process.exit(0);
}

sanitizeHectorChat().catch((err) => {
  console.error('Error durante el saneamiento:', err);
  process.exit(1);
});

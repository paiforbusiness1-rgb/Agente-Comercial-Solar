import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as fs from 'fs';

async function checkHectorChat() {
  const files = fs.readdirSync('.');
  const serviceAccountFile = files.find(f => f.startsWith('agente-comercial-solar-firebase-adminsdk-') && f.endsWith('.json'));
  if (!serviceAccountFile) {
    console.error('No service account file found');
    return;
  }
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountFile, 'utf-8'));
  
  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }
  const db = getFirestore();
  const phone = '5214777241148';
  const tenantId = 'o3energy_mexico';

  console.log(`Buscando chat para ${phone} en tenants/${tenantId}/chats...`);
  const doc = await db.collection(`tenants/${tenantId}/chats`).doc(phone).get();
  if (doc.exists) {
    const data = doc.data() as any;
    console.log('✅ Chat encontrado!');
    console.log('Nombre:', data.nombre);
    console.log('Phase:', data.state?.phase);
    console.log('CompletedSteps:', data.state?.completedSteps);
    console.log('FinancingConsentRequested:', data.state?.financingConsentRequested);
    console.log('FinancingConsentGiven:', data.state?.financingConsentGiven);
    console.log('MediaSentFlags:', data.state?.mediaSentFlags);
    console.log('BotDisabled:', data.botDisabled);
    console.log('\nÚltimos 10 mensajes:');
    data.messages?.slice(-10).forEach((m: any, i: number) => {
      console.log(` ${i + 1}. [${m.sender}] (${m.timestamp}): ${m.text.substring(0, 100)}...`);
    });
  } else {
    console.log('❌ No encontrado en chats');
  }
}

checkHectorChat().catch(console.error);

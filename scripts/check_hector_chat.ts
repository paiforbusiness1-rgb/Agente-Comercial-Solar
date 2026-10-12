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
  console.log('Buscando conversacion para:', phone);
  
  const doc = await db.collection('conversations').doc(`o3energy_mexico_${phone}`).get();
  if (doc.exists) {
    const data = doc.data() as any;
    console.log('Conversacion encontrada!');
    console.log('State / Step:', data.state || data.currentStep);
    console.log('Total messages:', data.messages?.length);
    console.log('\nUltimos 8 mensajes:');
    data.messages?.slice(-8).forEach((m: any) => {
      console.log(`[${m.sender}] (${m.timestamp}): ${m.text}`);
    });
  } else {
    console.log('No encontrada en conversations');
  }
}

checkHectorChat().catch(console.error);

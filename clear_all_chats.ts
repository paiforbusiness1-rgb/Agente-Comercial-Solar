import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';
import path from 'path';

let serviceAccount: any;
const jsonPath = path.join(process.cwd(), 'agente-comercial-solar-firebase-adminsdk-fbsvc-fb8f57df23.json');

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {}
} else if (fs.existsSync(jsonPath)) {
  serviceAccount = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
}

if (getApps().length === 0 && serviceAccount) {
  initializeApp({ projectId: 'agente-comercial-solar', credential: cert(serviceAccount) });
}

const db = getFirestore();

async function clearAllData() {
  console.log('🗑️  INICIANDO LIMPIEZA TOTAL DE CHATS Y LEADS EN FIRESTORE...\n');

  // 1. Clear V1 chats
  const v1Chats = await db.collection('chats').get();
  console.log(`- Eliminando ${v1Chats.size} chats de la colección 'chats' (V1)...`);
  for (const doc of v1Chats.docs) {
    await doc.ref.delete();
  }

  // 2. Clear V2 tenant chats
  const v2Chats = await db.collection('tenants/o3energy_mexico/chats').get();
  console.log(`- Eliminando ${v2Chats.size} chats de la colección 'tenants/o3energy_mexico/chats' (V2)...`);
  for (const doc of v2Chats.docs) {
    await doc.ref.delete();
  }

  // 3. Clear V2 tenant leads
  const v2Leads = await db.collection('tenants/o3energy_mexico/qualified_leads').get();
  console.log(`- Eliminando ${v2Leads.size} leads de la colección 'tenants/o3energy_mexico/qualified_leads' (V2)...`);
  for (const doc of v2Leads.docs) {
    await doc.ref.delete();
  }

  console.log('\n✅ LIMPIEZA COMPLETADA CON ÉXITO.');
  process.exit(0);
}

clearAllData().catch((err) => {
  console.error('❌ Error limpiando Firestore:', err);
  process.exit(1);
});

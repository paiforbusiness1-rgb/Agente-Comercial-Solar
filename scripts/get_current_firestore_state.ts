import 'dotenv/config';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as fs from 'fs';

async function main() {
  const files = fs.readdirSync('.');
  const serviceAccountFile = files.find(f => f.startsWith('agente-comercial-solar-firebase-adminsdk-') && f.endsWith('.json'));
  if (!serviceAccountFile) {
    console.error('No service account found');
    process.exit(1);
  }
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountFile, 'utf-8'));
  if (!getApps().length) initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore();
  const doc = await db.collection('tenants/o3energy_mexico/chats').doc('5214777241148').get();
  const d = doc.data() as any;
  console.log('=== ESTADO ACTUAL EN FIRESTORE ===');
  console.log('Phase:', d?.state?.phase);
  console.log('CurrentStep:', d?.state?.currentStep);
  console.log('MonthlyBill:', d?.state?.monthlyBill);
  console.log('BimestralBill:', d?.state?.bimestralBill);
  console.log('RoofType:', d?.state?.roofType);
  console.log('HasShade:', d?.state?.hasShade);
  console.log('QuoteConsentRequested:', d?.state?.quoteConsentRequested);
  console.log('QuoteConsentGiven:', d?.state?.quoteConsentGiven);
  console.log('FinancingConsentRequested:', d?.state?.financingConsentRequested);
  console.log('FinancingConsentGiven:', d?.state?.financingConsentGiven);
  console.log('BotDisabled:', d?.botDisabled);
  console.log('CompletedSteps:', JSON.stringify(d?.state?.completedSteps));
  console.log('\n=== HISTORIAL DE MENSAJES (' + (d?.messages?.length || 0) + ') ===');
  d?.messages?.forEach((m: any, i: number) => {
    console.log(`[${i}] (${m.sender} ${m.timestamp}): ${m.text}`);
  });
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

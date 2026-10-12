import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';
import fs from 'fs';

const firebaseConfig = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function run() {
  console.log('Connecting to Firestore with client SDK...');
  const snap = await getDocs(collection(db, 'tenants/o3energy_mexico/chats'));
  console.log(`Retrieved ${snap.docs.length} chats from Firestore.`);

  const juanChats = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    const nombre = data.nombre || '';
    const stateName = data.state?.clientName || '';
    const messages = data.messages || [];
    const hasJuan = /juan/i.test(nombre) || /juan/i.test(stateName) || messages.some(m => /juan/i.test(m.text || ''));
    if (hasJuan) {
      juanChats.push({ id: doc.id, phone: data.phone, nombre, messageCount: messages.length, lastMessageAt: data.lastMessageAt, data });
    }
  }

  if (juanChats.length === 0) {
    console.log('No chat found matching "Juan". Listing all chats:');
    for (const doc of snap.docs) {
      const data = doc.data();
      console.log(`[${doc.id}] Name: ${data.nombre} | Phone: ${data.phone} | LastMessageAt: ${data.lastMessageAt}`);
    }
    return;
  }

  for (const item of juanChats) {
    console.log(`\n=================== CHAT: ${item.nombre} (${item.phone || item.id}) ===================`);
    console.log('State:', JSON.stringify(item.data.state, null, 2));
    console.log('BotDisabled:', item.data.botDisabled);
    console.log('LastMessageAt:', item.data.lastMessageAt);
    console.log('--- Messages ---');
    (item.data.messages || []).forEach((m, idx) => {
      console.log(`[${idx + 1}] [${m.timestamp}] ${m.sender.toUpperCase()}: ${m.text}`);
    });
  }
}

run().catch(console.error);

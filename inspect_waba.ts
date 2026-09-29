import 'dotenv/config';
import fetch from 'node-fetch';

async function inspectWABA() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  console.log('Testing with token from .env:', token ? token.substring(0, 20) + '...' : 'NONE');

  // Query WABA Phone Numbers
  const wabaId = '1311878291106652';
  const url = `https://graph.facebook.com/v20.0/${wabaId}/phone_numbers`;
  
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    console.log('WABA Phone Numbers Result:', JSON.stringify(data, null, 2));
  } catch (err: any) {
    console.error('Error fetching WABA numbers:', err);
  }
}

inspectWABA();

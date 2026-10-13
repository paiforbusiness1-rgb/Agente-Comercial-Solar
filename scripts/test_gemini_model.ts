import 'dotenv/config';
import { AppConfig } from '../server/shared/config/AppConfig.js';

async function testGeminiModel() {
  const apiKey = AppConfig.gemini.apiKey;
  const model = AppConfig.gemini.model;
  console.log('Testing model:', model);

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
    })
  });

  console.log('Status:', res.status, res.statusText);
  const data = await res.json();
  console.log('Response:', JSON.stringify(data, null, 2));
}

testGeminiModel().catch(console.error);

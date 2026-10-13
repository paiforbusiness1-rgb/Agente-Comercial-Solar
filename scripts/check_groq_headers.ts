import 'dotenv/config';
import { AppConfig } from '../server/shared/config/AppConfig.js';

async function checkGroqLimits() {
  const apiKey = AppConfig.groq.apiKey;
  const model = AppConfig.groq.model;
  console.log('Model:', model);
  console.log('API Key exists:', Boolean(apiKey));

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    }),
  });

  console.log('Status:', res.status, res.statusText);
  for (const [key, value] of res.headers.entries()) {
    if (key.includes('ratelimit') || key.includes('retry')) {
      console.log(` ${key}: ${value}`);
    }
  }

  const data = await res.json() as any;
  console.log('Response:', data?.choices?.[0]?.message?.content || data);
}

checkGroqLimits().catch(console.error);

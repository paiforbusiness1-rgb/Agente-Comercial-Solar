import 'dotenv/config';
import { AppConfig } from '../server/shared/config/AppConfig.js';
import { SofiaPromptBuilder } from '../server/application/builders/SofiaPromptBuilder.js';

async function testGeminiWithRealPrompt() {
  const apiKey = AppConfig.gemini.apiKey;
  const model = AppConfig.gemini.model;

  const promptCtx = {
    tenantName: AppConfig.tenant.defaultId,
    clientName: 'Héctor',
    clientPhone: '5214777241148',
    currentStep: 2,
    extractedData: { client_name: 'Héctor' },
    latestUserMessage: 'te comparto los recibos aguarda!',
    historySummary: 'user: hola me ayudas?\nbot: ¡Hola! Bienvenido a O3 Energy...\nuser: soy hector\nbot: ¡Hola Héctor! ...',
    isReturningContext: false,
    mediaSentFlags: { instalacionProfessional: true },
  };

  const { systemPrompt, userContent } = SofiaPromptBuilder.buildPrompt(promptCtx as any);

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const start = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });

  const duration = Date.now() - start;
  console.log(`Status: ${res.status} in ${duration}ms`);
  const data = await res.json();
  console.log('Response:', JSON.stringify(data, null, 2));
}

testGeminiWithRealPrompt().catch(console.error);

import 'dotenv/config';
import { AppConfig } from '../server/shared/config/AppConfig.js';
import { ResilientLLMProvider } from '../server/infrastructure/llm/ResilientLLMProvider.js';

async function testGeminiFallbackDirectly() {
  console.log('AppConfig.gemini.apiKey exists:', Boolean(AppConfig.gemini.apiKey));
  console.log('AppConfig.gemini.model:', AppConfig.gemini.model);

  const provider = new ResilientLLMProvider();
  // Force Groq circuit open so it goes directly to Gemini
  (provider as any).groqCircuit.trip();

  console.log('Groq circuit is open:', provider.groqCircuit.isOpen());

  try {
    const res = await provider.complete([
      { role: 'system', content: 'Responde siempre en formato JSON {"status": "ok"}' },
      { role: 'user', content: 'hola' }
    ]);
    console.log('✅ Gemini Fallback Respondió con éxito:');
    console.log(res.text);
  } catch (err: any) {
    console.error('❌ Gemini Fallback FALLÓ:', err.message);
  }
}

testGeminiFallbackDirectly().catch(console.error);

import 'dotenv/config';
import { SofiaPromptBuilder } from '../server/application/builders/SofiaPromptBuilder.js';
import { ResilientLLMProvider } from '../server/infrastructure/llm/ResilientLLMProvider.js';

async function testTurn15() {
  const provider = new ResilientLLMProvider();
  (provider as any).groqCircuit.trip('Test Trip'); // Force Gemini fallback

  // Reconstrucción del contexto exacto de Turno 15
  const history = [
    'user: concreto',
    'bot: ¡Excelente, Héctor! Tu techo es de concreto. Ahora, ¿hay alguna sombra...',
    'user: si despejado',
    'bot: ¡Excelente, Héctor! Con tu techo de concreto y despejado... ¿Te gustaría que te presente la propuesta...',
    'user: si por favor',
    'bot: ¡Con mucho gusto, Héctor! Aquí tienes tu propuesta personalizada:\n\n☀️ Sistema Propuesto: 12 paneles solares...\n\n¿Te gustaría conocer nuestras opciones de financiamiento con pagos mensuales accesibles o prefieres agendar una visita técnica gratuita a tu domicilio? 📅',
  ].join('\n');

  const { systemPrompt, userContent } = SofiaPromptBuilder.buildPrompt({
    phone: '5214777241148',
    userName: 'Héctor',
    currentStep: 4,
    extractedData: {
      billAmount: 148228,
      billFrequency: 'mensual',
      roofType: 'concreto',
      hasShade: false,
      shadowsAssessed: true,
      equivalenceStated: true,
    },
    calculatedQuote: {
      panels: 12,
      systemPowerKw: 6.6,
      estimatedCost: 77700,
      monthlySavings: 133405,
      annualSavings: 1600862,
      rangeLabel: '12 paneles (6.6 kWp)',
    },
    quoteConsentRequested: true,
    quoteConsentGiven: true,
    financingConsentRequested: false,
    financingConsentGiven: false,
    botDisabled: false,
    latestUserMessage: 'si',
    historySummary: history,
    mediaSentFlags: { instalacionProfessional: true },
  });

  console.log('Llamando a complete() con Gemini (Groq tripped)...');
  const start = Date.now();
  try {
    const res = await provider.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ]);
    console.log(`✅ Éxito en ${Date.now() - start}ms:`);
    console.log(res.text);

    // Intentar parsear
    const parsed = SofiaPromptBuilder.parseResponse(res.text || '');
    console.log('Parsed:', JSON.stringify(parsed, null, 2));
  } catch (err: any) {
    console.error(`❌ Falló en ${Date.now() - start}ms:`, err.message);
  }
}

testTurn15().catch(console.error);

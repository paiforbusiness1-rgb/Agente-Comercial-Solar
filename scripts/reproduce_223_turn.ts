import 'dotenv/config';
import { SofiaPromptBuilder } from '../server/application/builders/SofiaPromptBuilder.js';
import { ResilientLLMProvider } from '../server/infrastructure/llm/ResilientLLMProvider.js';
import { GroqProvider } from '../server/infrastructure/llm/GroqProvider.js';

async function reproduce() {
  const provider = new ResilientLLMProvider(new GroqProvider(7000));
  
  const history = [
    'user: concreto',
    'bot: ¡Excelente, Héctor! Tu techo es de concreto. Ahora, ¿hay alguna sombra...',
    'user: si despejado',
    'bot: ¡Excelente, Héctor! Con tu techo de concreto y despejado... ¿Te gustaría que te presente la propuesta...',
    'user: si por favor',
    'bot: ¡Con mucho gusto, Héctor! Aquí tienes tu propuesta personalizada... ¿Te gustaría conocer nuestras opciones de financiamiento...',
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

  console.log('Sending message to ResilientLLMProvider...');
  try {
    const res = await provider.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ]);
    console.log('LLM Result:', res.text);
  } catch (err: any) {
    console.error('LLM Error:', err.message, 'Status:', err.status);
  }
}

reproduce().catch(console.error);

import 'dotenv/config';
import { SofiaPromptBuilder } from '../server/application/builders/SofiaPromptBuilder.js';
import { AppConfig } from '../server/shared/config/AppConfig.js';

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

console.log('System prompt length (chars):', systemPrompt.length);
console.log('User content length (chars):', userContent.length);
console.log('Approx tokens (~4 chars/token):', Math.round((systemPrompt.length + userContent.length) / 3.5));

import 'dotenv/config';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as fs from 'fs';
import { SofiaFlowOrchestrator } from '../server/application/orchestration/SofiaFlowOrchestrator.js';
import { FirestoreConversationRepository, FirestoreLeadRepository } from '../server/infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../server/infrastructure/engines/SolarQuoteEngine.js';
import { ResilientLLMProvider } from '../server/infrastructure/llm/ResilientLLMProvider.js';
import { SofiaPromptBuilder } from '../server/application/builders/SofiaPromptBuilder.js';
import { AppConfig } from '../server/shared/config/AppConfig.js';

async function diagnoseStep2() {
  const files = fs.readdirSync('.');
  const serviceAccountFile = files.find(f => f.startsWith('agente-comercial-solar-firebase-adminsdk-') && f.endsWith('.json'));
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountFile!, 'utf-8'));
  
  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }
  const db = getFirestore();
  const phone = '5214777241148';
  const tenantId = 'o3energy_mexico';

  const doc = await db.collection(`tenants/${tenantId}/chats`).doc(phone).get();
  const conv = doc.data() as any;

  console.log('=== DIAGNÓSTICO EN VIVO: REPRODUCIENDO MENSAJE "te comparto los recibos aguarda!" ===');
  console.log('Phase:', conv.state?.phase);
  console.log('Nombre:', conv.nombre);
  console.log('Messages count:', conv.messages?.length);

  // Mensajes antes del fallo (excluyendo el último bot fallback [7] y el último user [6])
  const messagesBefore = conv.messages.slice(0, 5);
  const promptCtx = {
    tenantName: AppConfig.tenant.defaultId,
    clientName: conv.nombre,
    clientPhone: phone,
    currentStep: 2,
    extractedData: {
      client_name: conv.nombre,
    },
    latestUserMessage: 'te comparto los recibos aguarda!',
    historySummary: messagesBefore
      .filter((m: any) => !m.text.startsWith('📄 [Brochure Enviado]'))
      .map((m: any) => `${m.sender}: ${m.text}`)
      .join('\n'),
    isReturningContext: false,
    mediaSentFlags: conv.state.mediaSentFlags || {},
  };

  const { systemPrompt, userContent } = SofiaPromptBuilder.buildPrompt(promptCtx as any);

  const llmProvider = new ResilientLLMProvider();

  console.log('\nLlamando a ResilientLLMProvider...');
  const start = Date.now();
  try {
    const resp = await llmProvider.complete(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      [],
      0.2
    );
    const duration = Date.now() - start;
    console.log(`✅ LLM respondió en ${duration}ms:`);
    console.log('Raw output:', resp.text);

    const parsed = SofiaPromptBuilder.parseResponse(resp.text || '');
    console.log('\nParsed JSON:', JSON.stringify(parsed, null, 2));
  } catch (err: any) {
    const duration = Date.now() - start;
    console.error(`❌ LLM FALLÓ tras ${duration}ms:`, err.message);
    console.error(err.stack);
  }
}

diagnoseStep2().catch(console.error);

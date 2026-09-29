import 'dotenv/config';
import fetch from 'node-fetch';
import { AppConfig } from './server/shared/config/AppConfig.js';
import { GroqProvider } from './server/infrastructure/llm/GroqProvider.js';
import { SolarQuoteEngine } from './server/infrastructure/engines/SolarQuoteEngine.js';
import { LLMOrchestrator } from './server/application/orchestrators/LLMOrchestrator.js';
import { SOFIA_DEFINITION } from './server/agents/definitions/Sofia.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from './server/infrastructure/persistence/Repositories.js';
import { ReceiveMessageUseCase } from './server/application/usecases/ReceiveMessageUseCase.js';

interface TestStepResult {
  step: string;
  status: 'PASSED' | 'FAILED' | 'WARNING';
  details: string;
  data?: any;
}

const results: TestStepResult[] = [];

async function runE2EPipelineTest() {
  console.log('===============================================================');
  console.log('🧪 INICIANDO PRUEBA INTEGRAL E2E DEL PIPELINE (WHATSAPP + SOFÍA)');
  console.log('===============================================================\n');

  const testPhone = '526141753500';
  const testMessage = 'Hola, me puedes ayudar? Pago 4,500 al mes de luz en Chihuahua';

  // ─── ETAPA 1: Verificación de Variables de Entorno ───────────────────────
  console.log('▶ ETAPA 1: Comprobación de Configuración & Credenciales');
  const groqKey = AppConfig.groq.apiKey;
  const metaToken = AppConfig.meta.accessToken;
  const phoneNumberId = AppConfig.meta.phoneNumberId;
  const verifyToken = AppConfig.meta.verifyToken;

  console.log(`- GROQ_API_KEY: ${groqKey ? 'Configurada (' + groqKey.substring(0, 10) + '...)' : '❌ FALTANTE'}`);
  console.log(`- WHATSAPP_ACCESS_TOKEN: ${metaToken ? 'Configurado (' + metaToken.substring(0, 15) + '...)' : '❌ FALTANTE'}`);
  console.log(`- WHATSAPP_PHONE_NUMBER_ID: ${phoneNumberId || '❌ FALTANTE'}`);
  console.log(`- WHATSAPP_VERIFY_TOKEN: ${verifyToken || '❌ FALTANTE'}`);

  if (!groqKey || !metaToken || !phoneNumberId) {
    results.push({
      step: '1. Variables de Entorno',
      status: 'FAILED',
      details: 'Faltan variables críticas en la configuración (.env)',
      data: { hasGroq: !!groqKey, hasMetaToken: !!metaToken, hasPhoneId: !!phoneNumberId }
    });
  } else {
    results.push({
      step: '1. Variables de Entorno',
      status: 'PASSED',
      details: 'Todas las variables requeridas están presentes en el entorno local',
    });
  }

  // ─── ETAPA 2: Handshake del Webhook en Vercel (GET) ──────────────────────
  console.log('\n▶ ETAPA 2: Test del Webhook en Producción (Vercel Handshake GET)');
  try {
    const vercelUrl = 'https://agente-comercial-solar.vercel.app/api/whatsapp-webhook';
    const challengeStr = 'challenge_test_12345';
    const getRes = await fetch(`${vercelUrl}?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=${challengeStr}`);
    const body = await getRes.text();

    if (getRes.status === 200 && body === challengeStr) {
      console.log('✅ Webhook GET Handshake en Vercel: 200 OK (Challenge verificado)');
      results.push({
        step: '2. Webhook GET Handshake (Vercel)',
        status: 'PASSED',
        details: 'Vercel responde correctamente a la verificación de Meta',
      });
    } else {
      console.log(`❌ Webhook GET Handshake falló: Status ${getRes.status}, Body: ${body}`);
      results.push({
        step: '2. Webhook GET Handshake (Vercel)',
        status: 'FAILED',
        details: `Status ${getRes.status}: ${body}`,
      });
    }
  } catch (err: any) {
    console.log(`❌ Error conectando a Vercel Webhook GET: ${err.message}`);
    results.push({
      step: '2. Webhook GET Handshake (Vercel)',
      status: 'FAILED',
      details: err.message,
    });
  }

  // ─── ETAPA 3: Motor de IA y Cotización (Groq + Sofía Orchestrator) ───────
  console.log('\n▶ ETAPA 3: Test del Motor de IA (Sofía + Tool Calling)');
  let generatedReply = '';
  try {
    const quoteEngine = new SolarQuoteEngine();
    const llmProvider = new GroqProvider();
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const orchestrator = new LLMOrchestrator(llmProvider, quoteEngine, leadRepo, convRepo);

    let sentViaWhatsApp = false;
    const mockSender = async (phone: string, text: string) => {
      sentViaWhatsApp = true;
      console.log(`[Mock Sender] Despacho preparado para +${phone}: "${text.substring(0, 70)}..."`);
      return true;
    };

    const useCase = new ReceiveMessageUseCase(convRepo, orchestrator, SOFIA_DEFINITION, mockSender);
    const execution = await useCase.execute({
      phone: testPhone,
      text: testMessage,
      name: 'Héctor Test',
      tenantId: 'o3energy_mexico',
    });

    generatedReply = execution.reply;
    console.log('✅ Sofía respondió con éxito:');
    console.log(`"${generatedReply}"`);

    results.push({
      step: '3. Motor de IA (Groq / Sofía)',
      status: 'PASSED',
      details: 'Sofía procesó el mensaje y generó respuesta con cotización preliminar',
      data: { reply: generatedReply, leadGenerated: execution.leadGenerated }
    });
  } catch (err: any) {
    console.log(`❌ Error en Motor de IA: ${err.message}`);
    results.push({
      step: '3. Motor de IA (Groq / Sofía)',
      status: 'FAILED',
      details: err.message,
    });
  }

  // ─── ETAPA 4: Conectividad y Validación con Meta Graph API (WhatsApp) ────
  console.log('\n▶ ETAPA 4: Test de Autenticación y Envío a Meta Graph API');
  try {
    // 4.1 Verificar información del Phone Number ID ante Meta
    const metaCheckUrl = `https://graph.facebook.com/v20.0/${phoneNumberId}`;
    console.log(`Consultando número en Meta: ${metaCheckUrl}`);
    const metaCheckRes = await fetch(metaCheckUrl, {
      headers: { Authorization: `Bearer ${metaToken}` }
    });
    const metaCheckData = await metaCheckRes.json() as any;

    console.log('Respuesta de Meta Phone Number:', JSON.stringify(metaCheckData, null, 2));

    if (!metaCheckRes.ok) {
      results.push({
        step: '4. Meta Graph API Authentication',
        status: 'FAILED',
        details: `Meta rechazó las credenciales (HTTP ${metaCheckRes.status}): ${metaCheckData?.error?.message || 'Error desconocido'}`,
        data: metaCheckData
      });
    } else {
      results.push({
        step: '4. Meta Graph API Authentication',
        status: 'PASSED',
        details: `Número válido en Meta: ${metaCheckData.display_phone_number || metaCheckData.id}`,
        data: metaCheckData
      });

      // 4.2 Intentar envío de mensaje real a través de Meta
      console.log(`\nEnviando mensaje real de prueba a +${testPhone}...`);
      const sendRes = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${metaToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: testPhone,
          type: 'text',
          text: { preview_url: false, body: '🤖 [Test E2E Sofía] Pipeline verificado exitosamente.' }
        })
      });

      const sendData = await sendRes.json() as any;
      console.log('Respuesta de envío Meta:', JSON.stringify(sendData, null, 2));

      if (sendRes.ok) {
        results.push({
          step: '5. Meta WhatsApp Real Dispatch',
          status: 'PASSED',
          details: `Mensaje enviado con éxito. Message ID: ${sendData.messages?.[0]?.id}`,
          data: sendData
        });
      } else {
        results.push({
          step: '5. Meta WhatsApp Real Dispatch',
          status: 'FAILED',
          details: `Meta no pudo despachar el mensaje (Error ${sendData?.error?.code}): ${sendData?.error?.message} | Tipo: ${sendData?.error?.type}`,
          data: sendData
        });
      }
    }
  } catch (err: any) {
    console.log(`❌ Excepción al comunicarse con Meta Graph API: ${err.message}`);
    results.push({
      step: '4. Meta Graph API Connection',
      status: 'FAILED',
      details: err.message,
    });
  }

  // ─── ETAPA 5: Test de Recepción Webhook en Producción Vercel (POST) ───────
  console.log('\n▶ ETAPA 5: Test de Webhook POST en Vivo en Vercel');
  try {
    const postPayload = {
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                contacts: [{ profile: { name: 'Héctor Test E2E' }, wa_id: testPhone }],
                messages: [
                  {
                    from: testPhone,
                    id: `wamid_test_${Date.now()}`,
                    text: { body: 'Hola, prueba E2E' }
                  }
                ]
              }
            }
          ]
        }
      ]
    };

    const postRes = await fetch('https://agente-comercial-solar.vercel.app/api/whatsapp-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postPayload)
    });

    const postBody = await postRes.json() as any;
    console.log('Respuesta de Vercel Webhook POST:', postRes.status, postBody);

    if (postRes.status === 200 && postBody.status === 'received') {
      results.push({
        step: '6. Vercel Webhook Ingestion (POST)',
        status: 'PASSED',
        details: 'El endpoint de producción en Vercel ingesta y procesa el payload de WhatsApp sin errores HTTP',
        data: postBody
      });
    } else {
      results.push({
        step: '6. Vercel Webhook Ingestion (POST)',
        status: 'FAILED',
        details: `Status ${postRes.status}: ${JSON.stringify(postBody)}`,
      });
    }
  } catch (err: any) {
    console.log(`❌ Error en Vercel Webhook POST: ${err.message}`);
    results.push({
      step: '6. Vercel Webhook Ingestion (POST)',
      status: 'FAILED',
      details: err.message,
    });
  }

  console.log('\n===============================================================');
  console.log('📊 RESUMEN FINAL DEL TEST E2E');
  console.log('===============================================================');
  results.forEach(r => {
    const icon = r.status === 'PASSED' ? '✅' : r.status === 'WARNING' ? '⚠️' : '❌';
    console.log(`${icon} [${r.status}] ${r.step}: ${r.details}`);
  });
}

runE2EPipelineTest().catch(console.error);

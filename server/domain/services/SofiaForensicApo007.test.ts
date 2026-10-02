/**
 * SofiaForensicApo007.test.ts
 * Suite SQA Forense — Plan APO-007 (T18 - T21).
 * Valida:
 * 1. Sanitización de pushname (anti-asunción de perfiles WhatsApp como "GrupoSERTEI").
 * 2. Completitud técnica de sombras dirigida por estado en Paso 3.
 * 3. Gating estricto de consentimiento para el brochure de financiamiento (Paso 5).
 * 4. Flujo normal con sombras completas y rechazo elegante de financiamiento (Zero Spam).
 */

import { describe, it, expect, vi } from 'vitest';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { SofiaPromptBuilder, UserContext } from '../../application/builders/SofiaPromptBuilder.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { ILLMProvider } from '../../interfaces/ILLMProvider.js';

describe('SQA Forense Plan APO-007 — Tests T18 a T21 (Pushname, Sombras y Gating de Financiamiento)', () => {
  const tenantId = 'o3energy_mexico';

  // ─── T18: Sanitización de Pushname y Captura de Nombre Real ───────────────
  it('T18: Pushname corporativo "GrupoSERTEI" se sanitiza a "Cliente" y solicita nombre humano', async () => {
    const phone = '5214777000018';
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    // 1. Verificar sanitización en el Prompt Builder
    const testCtx: UserContext = {
      phone,
      userName: 'Cliente', // Como debe llegar tras la sanitización
      currentStep: 1,
      extractedData: {},
      botDisabled: false,
      latestUserMessage: 'Hola!',
    };

    const { systemPrompt, userContent } = SofiaPromptBuilder.buildPrompt(testCtx);
    expect(userContent).toContain('<name>Cliente</name>');
    expect(systemPrompt).toContain('MANEJO DEL NOMBRE HUMANO DEL CLIENTE (PASO 1)');
    expect(systemPrompt).toContain('¿con quién tengo el gusto?');

    // 2. Probar en el Orquestador con webhook entrante de "GrupoSERTEI"
    const mockLlm: ILLMProvider = {
      complete: vi.fn()
        // Primer turno: saluda y solicita nombre
        .mockResolvedValueOnce({
          text: JSON.stringify({
            next_step: 1,
            message_to_user: '¡Hola! Bienvenido a O3 Energy México ☀️ Con gusto te asesoro. Para brindarte una atención personalizada, ¿con quién tengo el gusto?',
            extracted_data: { client_name: null },
          }),
          toolCalls: [],
          finishReason: 'stop',
        })
        // Segundo turno: usuario responde su nombre "Soy Héctor"
        .mockResolvedValueOnce({
          text: JSON.stringify({
            next_step: 2,
            message_to_user: '¡Mucho gusto, Héctor! Para diseñar tu sistema solar, ¿cuánto pagas de luz?',
            extracted_data: { client_name: 'Héctor' },
          }),
          toolCalls: [],
          finishReason: 'stop',
        }),
    };

    const orchestrator = new SofiaFlowOrchestrator(
      convRepo,
      leadRepo,
      quoteEngine,
      mockLlm,
      vi.fn().mockResolvedValue(true),
      { sendLeadEmailNotification: vi.fn().mockResolvedValue(true) } as any
    );

    // Mensaje inicial con pushname empresarial
    const firstResult = await orchestrator.processMessage({
      tenantId,
      phone,
      userName: 'GrupoSERTEI',
      messageText: 'Hola!',
    });

    const convAfterFirst = await convRepo.findByPhone(tenantId, phone);
    expect(convAfterFirst.nombre).toBe('Cliente'); // NO asumió "GrupoSERTEI"
    expect(convAfterFirst.state.whatsappProfileName).toBe('GrupoSERTEI'); // Metadato preservado
    expect(firstResult.replyText).toContain('¿con quién tengo el gusto?');

    // Segundo mensaje: usuario indica su nombre
    const secondResult = await orchestrator.processMessage({
      tenantId,
      phone,
      messageText: 'Soy Héctor',
    });

    const convAfterSecond = await convRepo.findByPhone(tenantId, phone);
    expect(convAfterSecond.nombre).toBe('Héctor'); // Nombre real capturado
    expect(secondResult.replyText).toContain('Héctor');
  });

  // ─── T19: Completitud Técnica de Sombras en Paso 3 ─────────────────────────
  it('T19: Usuario responde solo techo y omite sombras → Orquestador bloquea Paso 4 y repregunta sombras', async () => {
    const phone = '5214777000019';
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    // Precargar conversación en Paso 3 con recibo ya calificado
    const conv = await convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor';
    conv.state.phase = 'TECHNICAL_SURVEY';
    conv.state.monthlyBill = 1400;
    conv.state.bimestralBill = 2800;
    conv.state.billFrequency = 'bimestral';
    conv.state.shadowsAssessed = false; // Sombras NO evaluadas aún
    await convRepo.save(conv);

    // LLM intenta avanzar prematuramente al Paso 4 omitiendo sombras
    const mockLlm: ILLMProvider = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          next_step: 4, // LLM intentando saltar a cotización
          message_to_user: '¡Genial, techo de concreto! ¿Te gustaría que te presente la propuesta preliminar?',
          extracted_data: {
            roof_type: 'concreto',
            shadows_status: 'unknown', // Sombras no respondidas
          },
          quote_consent_requested: true,
        }),
        toolCalls: [],
        finishReason: 'stop',
      }),
    };

    const orchestrator = new SofiaFlowOrchestrator(
      convRepo,
      leadRepo,
      quoteEngine,
      mockLlm,
      vi.fn().mockResolvedValue(true),
      { sendLeadEmailNotification: vi.fn().mockResolvedValue(true) } as any
    );

    const result = await orchestrator.processMessage({
      tenantId,
      phone,
      messageText: 'Es de concreto',
    });

    // Aserciones estrictas:
    // 1. Orquestador forzó nextStep = 3 (bloqueó Paso 4)
    expect(result.nextStep).toBe(3);
    const updatedConv = await convRepo.findByPhone(tenantId, phone);
    expect(updatedConv.state.phase).toBe('TECHNICAL_SURVEY');
    expect(updatedConv.state.roofType).toBe('concreto');
    expect(updatedConv.state.shadowsAssessed).toBe(false);

    // 2. El texto repregunta activamente por posibles sombras
    expect(result.replyText).toMatch(/sombras/i);
    expect(result.replyText).toMatch(/tinacos|árboles|arboles|construcciones/i);
  });

  // ─── T20: Gating Estricto de Consentimiento para Financiamiento (Paso 5) ──
  it('T20: Al presentar cotización NO envía brochure de financiamiento hasta confirmación expresa', async () => {
    const phone = '5214777000020';
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    // Conversación lista para ver cotización con sombras ya confirmadas
    const conv = await convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor';
    conv.state.phase = 'QUOTATION';
    conv.state.monthlyBill = 1400;
    conv.state.roofType = 'concreto';
    conv.state.shadowsAssessed = true;
    conv.state.hasShade = false;
    conv.state.quoteConsentRequested = true;
    await convRepo.save(conv);

    // Turno 1: Usuario acepta ver cotización -> Se muestra cotización y se OFRECE financiamiento
    const mockLlm: ILLMProvider = {
      complete: vi.fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            next_step: 5,
            message_to_user: '¡Perfecto Héctor! Aquí tienes la cotización. Además, ¿te gustaría conocer nuestros planes de financiamiento?',
            quote_consent_given: true,
            propose_financing: true,
            financing_consent_requested: true,
            financing_consent_given: false,
            media_to_send: null, // NO debe mandar imagen aún
          }),
          toolCalls: [],
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({
            next_step: 5,
            message_to_user: '¡Excelente! Te comparto las opciones de financiamiento disponibles.',
            financing_consent_given: true,
            media_to_send: 'FINANCIAMIENTO',
          }),
          toolCalls: [],
          finishReason: 'stop',
        }),
    };

    const orchestrator = new SofiaFlowOrchestrator(
      convRepo,
      leadRepo,
      quoteEngine,
      mockLlm,
      vi.fn().mockResolvedValue(true),
      { sendLeadEmailNotification: vi.fn().mockResolvedValue(true) } as any
    );

    // Usuario da consentimiento para la cotización
    const quoteResult = await orchestrator.processMessage({
      tenantId,
      phone,
      messageText: 'Si por favor!',
    });

    // Verificación Turno 1: Cotización mostrada, pero CERO brochure de financiamiento
    expect(quoteResult.replyText).toContain('PRESUPUESTO PRELIMINAR DE SISTEMA SOLAR');
    expect(quoteResult.mediaSent).toBeUndefined(); // Cero spam de financiamiento

    const convAfterQuote = await convRepo.findByPhone(tenantId, phone);
    expect(convAfterQuote.state.financingConsentRequested).toBe(true);
    expect(convAfterQuote.state.financingConsentGiven).toBeFalsy();

    // Turno 2: Usuario confirma expresamente que quiere ver financiamiento
    const financingResult = await orchestrator.processMessage({
      tenantId,
      phone,
      messageText: 'Sí, me gustaría ver el financiamiento',
    });

    // Verificación Turno 2: Ahora SÍ se despacha el brochure de financiamiento
    expect(financingResult.mediaSent).toBeDefined();
    expect(financingResult.mediaSent?.length).toBe(1);
    expect(financingResult.mediaSent?.[0]).toContain('FINANCIAMIENTO.jpeg');

    const convAfterFinancing = await convRepo.findByPhone(tenantId, phone);
    expect(convAfterFinancing.state.mediaSentFlags?.financiamiento).toBe(true);
    expect(convAfterFinancing.messages.some(m => m.text.includes('[Brochure Enviado]: Planes y requisitos de financiamiento'))).toBe(true);
  });

  // ─── T21: Flujo Normal con Sombras y Rechazo Elegante de Financiamiento ───
  it('T21: Datos completos avanzan a cotización y rechazo de financiamiento no despacha brochure', async () => {
    const phone = '5214777000021';
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    const conv = await convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor';
    conv.state.phase = 'TECHNICAL_SURVEY';
    conv.state.monthlyBill = 1400;
    await convRepo.save(conv);

    // Usuario proporciona techo Y confirma que no tiene sombras
    const mockLlm: ILLMProvider = {
      complete: vi.fn()
        // Paso 3 completo: techo y sombras evaluados -> avanza a Paso 4
        .mockResolvedValueOnce({
          text: JSON.stringify({
            next_step: 4,
            message_to_user: '¡Excelente, techo de teja y libre de sombras! ¿Te gustaría que te presente la propuesta preliminar?',
            extracted_data: {
              roof_type: 'teja',
              shadows_status: 'none',
              has_shade: false,
            },
            quote_consent_requested: true,
          }),
          toolCalls: [],
          finishReason: 'stop',
        })
        // Usuario rechaza financiamiento: prefiere contado
        .mockResolvedValueOnce({
          text: JSON.stringify({
            next_step: 6,
            message_to_user: 'Perfecto Héctor, el pago de contado ofrece el máximo retorno de inversión. ¿Te gustaría agendar una visita técnica gratuita?',
            financing_consent_given: false,
            propose_technical_visit: true,
            media_to_send: null,
          }),
          toolCalls: [],
          finishReason: 'stop',
        }),
    };

    const orchestrator = new SofiaFlowOrchestrator(
      convRepo,
      leadRepo,
      quoteEngine,
      mockLlm,
      vi.fn().mockResolvedValue(true),
      { sendLeadEmailNotification: vi.fn().mockResolvedValue(true) } as any
    );

    // Turno 1: Respuesta técnica completa
    const surveyResult = await orchestrator.processMessage({
      tenantId,
      phone,
      messageText: 'Es de teja y no tengo ninguna sombra, está completamente despejado',
    });

    expect(surveyResult.nextStep).toBe(4); // Avanza limpiamente a Paso 4 sin bloqueos
    const convAfterSurvey = await convRepo.findByPhone(tenantId, phone);
    expect(convAfterSurvey.state.roofType).toBe('teja');
    expect(convAfterSurvey.state.hasShade).toBe(false);
    expect(convAfterSurvey.state.shadowsAssessed).toBe(true);

    // Turno 2: Usuario dice que prefiere de contado
    const declineResult = await orchestrator.processMessage({
      tenantId,
      phone,
      messageText: 'Prefiero de contado, no ocupo financiamiento',
    });

    // Verificación: NUNCA se despachó el brochure de financiamiento
    expect(declineResult.mediaSent).toBeUndefined();
    const finalConv = await convRepo.findByPhone(tenantId, phone);
    expect(finalConv.state.mediaSentFlags?.financiamiento).toBeFalsy();
    expect(declineResult.replyText).toContain('visita técnica');
  });
});

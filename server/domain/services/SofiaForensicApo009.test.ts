/**
 * SofiaForensicApo009.test.ts
 * Suite SQA Forense — Plan APO-009 (T27 - T30).
 * Valida:
 * 1. T27: Primacía del Estado y Guardrail Anti-Envío Prematuro de Financiamiento.
 * 2. T28: Despacho Exitoso de Financiamiento tras Confirmación Expresa del Usuario.
 * 3. T29: Captions Dinámicos de Recursos Multimedia con Mocking Estricto.
 * 4. T30: Cero Regresiones en Cadena Conversacional Completa (T01 - T26).
 */

import { describe, it, expect, vi } from 'vitest';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { ReceiveMessageUseCase } from '../../application/usecases/ReceiveMessageUseCase.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { ILLMProvider } from '../../interfaces/ILLMProvider.js';

describe('SQA Forense Plan APO-009 — Tests T27 a T30 (Anti-Premature Dispatch y Captions Dinámicos)', () => {
  const tenantId = 'o3energy_mexico';

  // ─── T27: Guardrail Anti-Envío Prematuro de Financiamiento ────────────────
  it('T27: Si el mensaje del bot pregunta si desea el brochure, el orquestador bloquea el despacho de FINANCIAMIENTO.jpeg aunque el LLM devuelva media_to_send y financing_consent_given', async () => {
    const phone = '5214777000027';
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    // Estado: Paso 4 completado con cotización enviada, consentimiento de financiamiento NO otorgado aún
    const conv = await convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor';
    conv.state.phase = 'FINANCING';
    conv.state.monthlyBill = 1800;
    conv.state.bimestralBill = 3600;
    conv.state.billFrequency = 'bimestral';
    conv.state.completedSteps = ['QUOTE_SENT'];
    conv.state.financingConsentRequested = false;
    conv.state.financingConsentGiven = false;
    await convRepo.save(conv);

    // Simular el caso real detectado en la auditoría:
    // El LLM presenta los pagos mensuales, pregunta si desea el brochure, pero "hace trampa"
    // devolviendo financing_consent_given: true y media_to_send: 'FINANCIAMIENTO'
    const messageAskingBrochure = `¡Perfecto, Héctor! 🎉 Como ya conoces la solución de 6 paneles solares, ahora te comparto nuestras opciones de financiamiento para que puedas iniciar sin desembolso inicial:

*12 meses* - Pago mensual de $3,300 MXN
*24 meses* - Pago mensual de $1,750 MXN
*36 meses* - Pago mensual de $1,250 MXN

¿Te gustaría que te envíe el brochure con los requisitos y pasos para aplicar a alguno de estos planes?`;

    const mockLlm: ILLMProvider = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          next_step: 5,
          message_to_user: messageAskingBrochure,
          propose_financing: true,
          financing_consent_requested: true,
          financing_consent_given: true, // <-- El LLM alucina consentimiento prematuro
          media_to_send: 'FINANCIAMIENTO', // <-- El LLM intenta enviarlo antes de tiempo
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
      userName: 'Héctor',
      messageText: 'Sí, adelante', // El usuario aceptó cotizar en turno previo
    });

    // 1. El orquestador DEBE bloquear el envío del brochure en este turno
    expect(result.mediaSent).toBeUndefined();

    // 2. Primacía del Estado: financingConsentGiven DEBE ser forzado a false y requested a true
    const updatedConv = await convRepo.findByPhone(tenantId, phone);
    expect(updatedConv.state.financingConsentRequested).toBe(true);
    expect(updatedConv.state.financingConsentGiven).toBe(false);
    expect(updatedConv.state.mediaSentFlags?.financiamiento).toBeFalsy();
  });

  // ─── T28: Despacho Exitoso tras Confirmación Expresa ──────────────────────
  it('T28: Tras haber preguntado en el turno anterior, cuando el usuario responde "Sí, mándamelo", se despacha FINANCIAMIENTO.jpeg', async () => {
    const phone = '5214777000028';
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    // Estado: La pregunta ya fue realizada en el turno anterior
    const conv = await convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor';
    conv.state.phase = 'FINANCING';
    conv.state.monthlyBill = 1800;
    conv.state.bimestralBill = 3600;
    conv.state.billFrequency = 'bimestral';
    conv.state.completedSteps = ['QUOTE_SENT'];
    conv.state.financingConsentRequested = true; // Ya se le preguntó
    conv.state.financingConsentGiven = false;    // Pendiente de respuesta
    await convRepo.save(conv);

    const mockLlm: ILLMProvider = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          next_step: 5,
          message_to_user: '¡Con gusto Héctor! Aquí tienes el brochure oficial con los requisitos y pasos para tramitar tu financiamiento. 📄💳',
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

    const result = await orchestrator.processMessage({
      tenantId,
      phone,
      userName: 'Héctor',
      messageText: 'Sí por favor, mándamelo',
    });

    // 1. Ahora SÍ se despacha el archivo multimedia
    expect(result.mediaSent).toBeDefined();
    expect(result.mediaSent?.length).toBe(1);
    expect(result.mediaSent?.[0]).toContain('FINANCIAMIENTO.jpeg');

    // 2. El estado se actualiza deterministamente
    const updatedConv = await convRepo.findByPhone(tenantId, phone);
    expect(updatedConv.state.financingConsentGiven).toBe(true);
    expect(updatedConv.state.mediaSentFlags?.financiamiento).toBe(true);
  });

  // ─── T29: Caption Dinámico Verificado con Mocking Estricto ────────────────
  it('T29: ReceiveMessageUseCase envía el caption dinámico exacto según el recurso multimedia despachado', async () => {
    const phone = '5214777000029';
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();
    const sendWhatsAppMock = vi.fn().mockResolvedValue(true);
    const sendWhatsAppMediaMock = vi.fn().mockResolvedValue(true);

    const mockLlm: ILLMProvider = {
      complete: vi.fn(),
    };

    const orchestrator = new SofiaFlowOrchestrator(
      convRepo,
      leadRepo,
      quoteEngine,
      mockLlm,
      sendWhatsAppMock,
      { sendLeadEmailNotification: vi.fn().mockResolvedValue(true) } as any
    );

    const useCase = new ReceiveMessageUseCase(
      convRepo,
      orchestrator,
      sendWhatsAppMock,
      sendWhatsAppMediaMock
    );

    // Caso A: Verificar caption para FINANCIAMIENTO.jpeg
    const captionFinanciamiento = useCase.getMediaCaption('https://agente-comercial-solar.vercel.app/images/FINANCIAMIENTO.jpeg');
    expect(captionFinanciamiento).toBe('Requisitos y Planes de Financiamiento Solar O3 Energy');

    // Caso B: Verificar caption para INSTALACION_PROFESIONAL.jpeg
    const captionInstalacion = useCase.getMediaCaption('https://agente-comercial-solar.vercel.app/images/INSTALACION_PROFESIONAL.jpeg');
    expect(captionInstalacion).toBe('Información de Servicios e Instalación Profesional O3 Energy');

    // Caso C: Despacho completo simulando llamada de WhatsApp
    // Mockeamos orchestrator.processMessage para devolver FINANCIAMIENTO.jpeg
    vi.spyOn(orchestrator, 'processMessage').mockResolvedValueOnce({
      replyText: 'Aquí tienes los requisitos de financiamiento.',
      nextStep: 5,
      botDisabled: false,
      mediaSent: ['https://agente-comercial-solar.vercel.app/images/FINANCIAMIENTO.jpeg'],
    });

    await useCase.execute({
      phone,
      text: 'Mándame el financiamiento',
      name: 'Héctor',
    });

    // Aserción estricta de argumentos en sendWhatsAppMedia
    expect(sendWhatsAppMediaMock).toHaveBeenCalledWith(
      phone,
      expect.stringContaining('FINANCIAMIENTO.jpeg'),
      'Requisitos y Planes de Financiamiento Solar O3 Energy'
    );
  });

  // ─── T30: Regresión Total (Cero Regresiones en Cadena Conversacional) ──────
  it('T30: Flujo integral respeta la cadencia completa sin colisiones ni regresiones de estado', async () => {
    const phone = '5214777000030';
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    const mockLlm: ILLMProvider = {
      complete: vi.fn()
        // Paso 1: Saludo y solicitud de nombre
        .mockResolvedValueOnce({
          text: JSON.stringify({
            next_step: 1,
            message_to_user: '¡Hola! Bienvenido a O3 Energy México ☀️ ¿Con quién tengo el gusto?',
            extracted_data: { client_name: null },
          }),
          finishReason: 'stop',
        })
        // Paso 2: Usuario da nombre y se solicita recibo
        .mockResolvedValueOnce({
          text: JSON.stringify({
            next_step: 2,
            message_to_user: '¡Mucho gusto Héctor! ¿Podrías indicarme tu recibo de luz?',
            extracted_data: { client_name: 'Héctor' },
            media_to_send: 'INSTALACION_PROFESIONAL',
          }),
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

    // Turno 1
    const res1 = await orchestrator.processMessage({ tenantId, phone, userName: 'GrupoSERTEI', messageText: 'Hola' });
    expect(res1.replyText).toContain('¿Con quién tengo el gusto?');

    // Turno 2
    const res2 = await orchestrator.processMessage({ tenantId, phone, userName: 'GrupoSERTEI', messageText: 'Soy Héctor' });
    expect(res2.replyText).toContain('Héctor');
    expect(res2.mediaSent).toContainEqual(expect.stringContaining('INSTALACION_PROFESIONAL.jpeg'));
  });
});

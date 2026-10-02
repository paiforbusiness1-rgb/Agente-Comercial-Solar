/**
 * SofiaForensicApo008.test.ts
 * Suite SQA Forense — Plan APO-008 (T22 - T26).
 * Valida:
 * 1. T22: Idempotencia de Cotización en Paso 5 (Zero Re-envío tras "Si porfa!").
 * 2. T23: Cero Duplicación en Turno 4 (eliminación de viñetas redundantes de presupuesto).
 * 3. T24: Regla Anti-Loro en Paso 3 (<equivalence_already_stated> y no repetir equivalencia).
 * 4. T25: Estabilidad de Montos CFE (Cero Mitosis $1,800 -> $900 a lo largo de 4 turnos).
 * 5. T26: Fallback U-First al recibir imagen de recibo CFE sin texto.
 */

import { describe, it, expect, vi } from 'vitest';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { SofiaPromptBuilder, UserContext } from '../../application/builders/SofiaPromptBuilder.js';
import { ReceiveMessageUseCase } from '../../application/usecases/ReceiveMessageUseCase.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { ILLMProvider } from '../../interfaces/ILLMProvider.js';

describe('SQA Forense Plan APO-008 — Tests T22 a T26 (Anti-Redundancia, Anti-Mitosis y Fallback de Imagen)', () => {
  const tenantId = 'o3energy_mexico';

  // ─── T22: Idempotencia de Cotización en Paso 5 ─────────────────────────────
  it('T22: Tras cotizar en Paso 4, el usuario pide financiamiento ("Si porfa!") y el orquestador NO vuelve a enviar la tarjeta de cotización', async () => {
    const phone = '5214777000022';
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    // Precargar conversación donde ya se cotizó en Paso 4
    const conv = await convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Carlos';
    conv.state.phase = 'FINANCING';
    conv.state.monthlyBill = 1800;
    conv.state.bimestralBill = 3600;
    conv.state.billFrequency = 'bimestral';
    conv.state.roofType = 'concreto';
    conv.state.hasShade = false;
    conv.state.shadowsAssessed = true;
    conv.state.quoteConsentGiven = true;
    conv.state.financingConsentRequested = true;
    conv.state.completedSteps = ['QUOTE_SENT']; // Ya se envió cotización
    await convRepo.save(conv);

    const mockLlm: ILLMProvider = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          next_step: 5,
          message_to_user: '¡Excelente Carlos! Te comparto las opciones de financiamiento disponibles para tu proyecto solar.',
          extracted_data: {
            bill_amount: 1800,
            bill_frequency: 'bimestral',
          },
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
      userName: 'Carlos',
      messageText: 'Si porfa!',
    });

    // Validar que la respuesta NO reenvió la tarjeta de cotización
    expect(result.replyText).not.toContain('COTIZACIÓN PRELIMINAR');
    expect(result.replyText).not.toContain('PRESUPUESTO PRELIMINAR');
    expect(result.replyText).not.toContain('DIAGNÓSTICO ENERGÉTICO');
    expect(result.replyText).not.toContain('Resumen de propuesta');
    expect(result.replyText).toContain('financiamiento');
    expect(result.mediaSent).toContainEqual(expect.stringContaining('FINANCIAMIENTO.jpeg'));

    // Validar que QUOTE_SENT sigue presente en completedSteps (no se borró)
    const updatedConv = await convRepo.findByPhone(tenantId, phone);
    expect(updatedConv.state.completedSteps).toContain('QUOTE_SENT');
    expect(updatedConv.state.monthlyBill).toBe(1800);
  });

  // ─── T23: Cero Duplicación en Turno 4 (Tarjeta + Texto) ───────────────────
  it('T23: En Turno 4 el orquestador limpia las viñetas redundantes de presupuesto que el LLM intente generar', async () => {
    const phone = '5214777000023';
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    // Precargar conversación lista para cotizar
    const conv = await convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Carlos';
    conv.state.phase = 'QUOTATION';
    conv.state.monthlyBill = 1800;
    conv.state.bimestralBill = 3600;
    conv.state.billFrequency = 'bimestral';
    conv.state.roofType = 'concreto';
    conv.state.hasShade = false;
    conv.state.shadowsAssessed = true;
    conv.state.quoteConsentRequested = true;
    await convRepo.save(conv);

    // LLM responde intentando redactar viñetas de presupuesto que duplicarían la tarjeta oficial
    const duplicateText = `¡Con mucho gusto Carlos! Aquí tienes la cotización preliminar:
* Sistema: 4 paneles solares (2.30 kWp)
* Costo estimado: $26,000 MXN
* Ahorro mensual: $810 MXN
* Ahorro anual: $9,720 MXN
¿Te gustaría conocer nuestras opciones de financiamiento para pagar tu sistema con el mismo ahorro?`;

    const mockLlm: ILLMProvider = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          next_step: 4,
          message_to_user: duplicateText,
          quote_consent_given: true,
          propose_financing: true,
          financing_consent_requested: true,
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
      userName: 'Carlos',
      messageText: 'Sí por favor',
    });

    // 1. Debe incluir la tarjeta oficial generada por QuotePdfService
    expect(result.replyText).toContain('PRESUPUESTO PRELIMINAR DE SISTEMA SOLAR');
    expect(result.replyText).toContain('4 Paneles Solares');

    // 2. Las viñetas redundantes de texto deben haber sido filtradas
    expect(result.replyText).not.toContain('* Sistema: 4 paneles');
    expect(result.replyText).not.toContain('* Costo estimado: $26,000');

    // 3. La frase conversacional y la pregunta de financiamiento se preservan
    expect(result.replyText).toContain('¡Con mucho gusto Carlos!');
    expect(result.replyText).toContain('¿Te gustaría conocer nuestras opciones de financiamiento');

    // 4. "Costo estimado" fue totalmente erradicado del texto y la tarjeta oficial presenta "Inversión Total"
    expect(result.replyText).not.toContain('Costo estimado');
    expect(result.replyText).toContain('Inversión Total: *$26,000 MXN');
  });

  // ─── T24: Regla Anti-Loro en Paso 3 (equivalenceStated) ───────────────────
  it('T24: Cuando equivalenceStated es true, el prompt prohíbe repetir la equivalencia y el bot avanza directo', async () => {
    const phone = '5214777000024';

    // 1. Verificar PromptBuilder
    const ctx: UserContext = {
      phone,
      userName: 'Carlos',
      currentStep: 3,
      extractedData: {
        billAmount: 3600,
        billFrequency: 'bimestral',
        roofType: 'concreto',
        shadowsAssessed: true,
        equivalenceStated: true,
      },
      botDisabled: false,
      latestUserMessage: 'Es techo de concreto y no hay sombras',
    };

    const { systemPrompt, userContent } = SofiaPromptBuilder.buildPrompt(ctx);

    // Debe contener el tag XML anti-loro
    expect(userContent).toContain('<equivalence_already_stated>true</equivalence_already_stated>');

    // El system prompt debe contener la directiva estricta anti-loro
    expect(systemPrompt).toContain('DIRECTIVA ESTRICTA ANTI-LORO');
    expect(systemPrompt).toContain('TERMINANTEMENTE PROHIBIDO volver a recitar esta equivalencia');

    // 2. Verificar en el orquestador
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    const conv = await convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Carlos';
    conv.state.phase = 'TECHNICAL_SURVEY';
    conv.state.monthlyBill = 1800;
    conv.state.bimestralBill = 3600;
    conv.state.billFrequency = 'bimestral';
    conv.state.equivalenceStated = true;
    await convRepo.save(conv);

    const mockLlm: ILLMProvider = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          next_step: 4,
          message_to_user: '¡Perfecto Carlos! Con techo de concreto sin sombras podemos aprovechar al máximo la radiación solar. ¿Te gustaría que te presente la propuesta preliminar de inversión y ahorro estimado?',
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
      userName: 'Carlos',
      messageText: 'Es techo de concreto y no hay sombras',
    });

    // Validar que la respuesta no contiene la equivalencia repetida
    expect(result.replyText).not.toContain('equivale a $1,800 MXN al mes');
    expect(result.replyText).toContain('propuesta preliminar');
  });

  // ─── T25: Estabilidad de Montos CFE (Cero Mitosis $1,800 -> $900) ──────────
  it('T25: A lo largo de múltiples turnos, conv.state.monthlyBill permanece inmutable en $1,800 sin mitosis recursiva', async () => {
    const phone = '5214777000025';
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    const mockLlm: ILLMProvider = {
      complete: vi.fn()
        // Turno 1: Recibe monto en Paso 2
        .mockResolvedValueOnce({
          text: JSON.stringify({
            next_step: 2,
            message_to_user: 'Tu recibo de $3,600 bimestrales equivale a $1,800 al mes. ¿De qué material es tu techo?',
            extracted_data: { bill_amount: 3600, bill_frequency: 'bimestral' },
          }),
          finishReason: 'stop',
        })
        // Turno 2: Recibe techo y sombras en Paso 3
        .mockResolvedValueOnce({
          text: JSON.stringify({
            next_step: 4,
            message_to_user: '¡Excelente! ¿Deseas ver la cotización?',
            extracted_data: { roof_type: 'concreto', shadows_status: 'none' },
            quote_consent_requested: true,
          }),
          finishReason: 'stop',
        })
        // Turno 3: Acepta cotizar en Paso 4
        .mockResolvedValueOnce({
          text: JSON.stringify({
            next_step: 4,
            message_to_user: 'Aquí tienes la cotización. ¿Te interesaría conocer las opciones de financiamiento?',
            quote_consent_given: true,
            propose_financing: true,
          }),
          finishReason: 'stop',
        })
        // Turno 4: Acepta financiamiento en Paso 5 (Aquí ocurría el bug de mitosis $1800 -> $900)
        .mockResolvedValueOnce({
          text: JSON.stringify({
            next_step: 5,
            message_to_user: 'Te comparto los esquemas de financiamiento.',
            extracted_data: { bill_amount: 1800, bill_frequency: 'bimestral' }, // LLM repitiendo monthlyBill con frecuencia bimestral
            financing_consent_given: true,
            media_to_send: 'FINANCIAMIENTO',
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

    // Turno 1: Usuario da monto
    await orchestrator.processMessage({ tenantId, phone, userName: 'Carlos', messageText: 'Mi recibo llega de 3600 al bimestre' });
    let conv = await convRepo.findByPhone(tenantId, phone);
    expect(conv.state.monthlyBill).toBe(1800);
    expect(conv.state.bimestralBill).toBe(3600);

    // Turno 2: Usuario da techo y sombras
    await orchestrator.processMessage({ tenantId, phone, userName: 'Carlos', messageText: 'Techo de concreto y no tengo sombras' });
    conv = await convRepo.findByPhone(tenantId, phone);
    expect(conv.state.monthlyBill).toBe(1800);
    expect(conv.state.bimestralBill).toBe(3600);

    // Turno 3: Usuario pide ver cotización
    await orchestrator.processMessage({ tenantId, phone, userName: 'Carlos', messageText: 'Sí, adelante' });
    conv = await convRepo.findByPhone(tenantId, phone);
    expect(conv.state.monthlyBill).toBe(1800);
    expect(conv.state.bimestralBill).toBe(3600);
    expect(conv.state.completedSteps).toContain('QUOTE_SENT');

    // Turno 4: Usuario pide financiamiento
    await orchestrator.processMessage({ tenantId, phone, userName: 'Carlos', messageText: 'Si porfa!' });
    conv = await convRepo.findByPhone(tenantId, phone);

    // ¡EL MONTO MENSUAL DEBE SEGUIR SIENDO 1800 (NO 900)!
    expect(conv.state.monthlyBill).toBe(1800);
    expect(conv.state.bimestralBill).toBe(3600);
    expect(conv.state.completedSteps).toContain('QUOTE_SENT');
  });

  // ─── T26: Fallback de Imagen (U-First) ─────────────────────────────────────
  it('T26: Usuario envía imagen de recibo CFE sin texto → ReceiveMessageUseCase responde con solicitud amable de confirmación', async () => {
    const phone = '5214777000026';
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

    // Simular webhook entrante con mensaje de imagen sin texto
    const res = await useCase.execute({
      phone,
      text: '',
      isImage: true,
      name: 'Carlos',
    });

    const expectedFallback = 'He recibido tu imagen. Para asegurarme de leer el monto con total precisión, ¿podrías confirmarme por favor el monto total en pesos que aparece en el recibo? ¡Gracias!';

    expect(res.reply).toBe(expectedFallback);
    expect(sendWhatsAppMock).toHaveBeenCalledWith(phone, expectedFallback);

    // Verificar que la conversación guardó el registro histórico de la imagen y la respuesta
    const conv = await convRepo.findByPhone(tenantId, phone);
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[0].text).toContain('Imagen de recibo adjuntada');
    expect(conv.messages[1].text).toBe(expectedFallback);
  });
});

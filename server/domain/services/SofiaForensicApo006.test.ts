/**
 * SofiaForensicApo006.test.ts
 * Suite SQA Forense — Plan APO-006 (T15 - T17).
 * Valida la frase puente en Paso 2, la idempotencia anti-spam del brochure,
 * y la cadencia de al menos 1200ms en ReceiveMessageUseCase.
 */

import { describe, it, expect, vi } from 'vitest';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { ReceiveMessageUseCase } from '../../application/usecases/ReceiveMessageUseCase.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { ILLMProvider } from '../../interfaces/ILLMProvider.js';

describe('SQA Forense Plan APO-006 — Tests T15 a T17 (Cadencia y Brochure Paso 2)', () => {
  const tenantId = 'o3energy_mexico';
  const phone = '5214773975020';

  // ─── T15: Guardrail inteligente de Frase Puente en Paso 2 ─────────────────
  it('T15: LLM omite frase puente en Paso 2 → Orquestador la concatena limpiamente', async () => {
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    // LLM mockeado que omite la frase puente requerida
    const mockLlm: ILLMProvider = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          next_step: 2,
          message_to_user: '¡Hola! Claro que sí con gusto te ayudo. ¿Podrías indicarme el monto de tu recibo de luz y si es bimestral o mensual?',
          extracted_data: { client_name: 'Hector' },
          media_to_send: 'INSTALACION_PROFESIONAL',
          quote_consent_requested: false,
          quote_consent_given: false,
          trigger_human_handoff: false,
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
      userName: 'Hector Alvarez',
      messageText: 'Hola, me interesa cotizar paneles para mi casa',
    });

    // 1. Verificación del Guardrail de Frase Puente (Refinamiento 1)
    expect(result.replyText).toContain('¿Podrías indicarme el monto de tu recibo de luz y si es bimestral o mensual?');
    expect(result.replyText).toMatch(/mientras me pasas el dato, te comparto informaci[oó]n detallada de nuestro servicio/i);

    // 2. Verificación de que mediaSent incluye el brochure
    expect(result.mediaSent).toBeDefined();
    expect(result.mediaSent?.length).toBe(1);
    expect(result.mediaSent?.[0]).toContain('INSTALACION_PROFESIONAL.jpeg');

    // 3. Verificación de que en la conversación se guardó el registro legible para el CRM
    const savedConv = await convRepo.findByPhone(tenantId, phone);
    expect(savedConv.messages.some(m => m.text.includes('[Brochure Enviado]'))).toBe(true);
  });

  // ─── T16: Idempotencia Anti-Spam del Envío de Brochure ────────────────────
  it('T16: Idempotencia Anti-Spam: el brochure se despacha una sola vez y no se repite', async () => {
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    const mockLlm: ILLMProvider = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          next_step: 2,
          message_to_user: '¿Cuánto pagas de luz?',
          media_to_send: 'INSTALACION_PROFESIONAL',
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

    // Primer mensaje: Bandera está apagada -> DEBE enviar brochure
    const firstResult = await orchestrator.processMessage({
      tenantId,
      phone: '5214778889900',
      messageText: 'Hola quiero cotizar',
    });

    expect(firstResult.mediaSent).toBeDefined();
    expect(firstResult.mediaSent?.length).toBe(1);

    const convAfterFirst = await convRepo.findByPhone(tenantId, '5214778889900');
    expect(convAfterFirst.state.mediaSentFlags.instalacionProfessional).toBe(true);

    // Segundo mensaje en el mismo Paso 2: Bandera ya está encendida -> NO DEBE volver a enviar brochure
    const secondResult = await orchestrator.processMessage({
      tenantId,
      phone: '5214778889900',
      messageText: 'Espera déjame buscar mi recibo',
    });

    expect(secondResult.mediaSent).toBeUndefined(); // Cero spam garantizado
  });

  // ─── T17: Cadencia Conversacional (Delay >= 1200ms antes de Media) ─────────
  it('T17: ReceiveMessageUseCase ejecuta una cadencia de al menos 1200ms entre texto y multimedia', async () => {
    const convRepo = new InMemoryConversationRepository();
    const timestamps: { textSentAt?: number; mediaSentAt?: number } = {};

    const mockOrchestrator = {
      processMessage: vi.fn().mockResolvedValue({
        replyText: '¿Podrías indicarme el monto de tu recibo de luz? Mientras me pasas el dato te comparto información.',
        nextStep: 2,
        botDisabled: false,
        mediaSent: ['https://agente-comercial-solar.vercel.app/images/INSTALACION_PROFESIONAL.jpeg'],
      }),
    } as unknown as SofiaFlowOrchestrator;

    const mockSendWhatsApp = vi.fn(async (_phone: string, _text: string) => {
      timestamps.textSentAt = Date.now();
      return true;
    });

    const mockSendWhatsAppMedia = vi.fn(async (_phone: string, _mediaUrl: string, _caption?: string) => {
      timestamps.mediaSentAt = Date.now();
      return true;
    });

    const useCase = new ReceiveMessageUseCase(
      convRepo,
      mockOrchestrator,
      mockSendWhatsApp,
      mockSendWhatsAppMedia
    );

    const startTime = Date.now();
    await useCase.execute({
      phone,
      text: 'Hola quiero información',
      name: 'Hector Alvarez',
    });
    const totalDuration = Date.now() - startTime;

    // Aserciones estrictas de cadencia
    expect(mockSendWhatsApp).toHaveBeenCalledTimes(1);
    expect(mockSendWhatsAppMedia).toHaveBeenCalledTimes(1);
    expect(timestamps.textSentAt).toBeDefined();
    expect(timestamps.mediaSentAt).toBeDefined();

    const delayBetweenCalls = timestamps.mediaSentAt! - timestamps.textSentAt!;
    expect(delayBetweenCalls).toBeGreaterThanOrEqual(1190); // Margen de tolerancia de timer de 1200ms
    expect(totalDuration).toBeGreaterThanOrEqual(1190);
  });
});

/**
 * SofiaForensicApo026.test.ts
 * Batería SQA Forense de Validación Arquitectónica APO-026.
 * Auditoría: Qwen Senior Forensic Auditor & Héctor Álvarez.
 * Mandatos:
 * - T93: Fase QUOTATION, completedSteps incluye QUOTE_SENT, usuario envía "si", LLM lanza HTTP 429 -> Fallback responde con desglose de financiamiento y pregunta por el brochure, phase cambia a FINANCING y financingConsentRequested = true.
 * - T94: Fase QUOTATION, completedSteps incluye QUOTE_SENT, usuario envía "agendar visita", LLM lanza HTTP 429 -> Fallback transiciona a HUMAN_HANDOFF, botDisabled = true, y se genera lead.
 * - T95: Fase FINANCING, financingConsentRequested = true, usuario envía "si", LLM lanza HTTP 429 -> Envía brochure FINANCIAMIENTO.jpeg, transiciona a CLOSING y propone visita técnica.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReceiveMessageUseCase } from '../../application/usecases/ReceiveMessageUseCase.js';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { WhatsAppMediaService } from '../../infrastructure/media/WhatsAppMediaService.js';
import { CfeReceiptExtractorService } from '../services/CfeReceiptExtractorService.js';

describe('SQA Forense Plan APO-026 — Tests T93 a T95 (Resolución de Grieta entre QUOTATION y FINANCING)', () => {
  const tenantId = 'o3energy_mexico';

  function createTestHarness(options?: {
    llmFails?: boolean;
    llmErrorStatus?: number;
    llmErrorMessage?: string;
  }) {
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();
    const sendWhatsApp = vi.fn().mockResolvedValue(true);
    const sendWhatsAppMedia = vi.fn().mockResolvedValue(true);

    const mockLlm = {
      complete: vi.fn().mockImplementation(async () => {
        if (options?.llmFails) {
          const err = new Error(options.llmErrorMessage || 'Groq API error 429: Rate limit exceeded (8000 TPM)');
          if (options.llmErrorStatus) {
            (err as any).status = options.llmErrorStatus;
          }
          throw err;
        }
        return {
          text: JSON.stringify({
            next_step: 5,
            message_to_user: 'Respuesta normal de LLM',
            extracted_data: {},
          }),
          finishReason: 'stop',
        };
      }),
    };

    const orchestrator = new SofiaFlowOrchestrator(
      convRepo,
      leadRepo,
      quoteEngine,
      mockLlm as any,
      sendWhatsApp as any,
      { sendLeadEmailNotification: vi.fn().mockResolvedValue(true) } as any
    );

    const mediaService = new WhatsAppMediaService();
    const extractorService = new CfeReceiptExtractorService();

    const useCase = new ReceiveMessageUseCase(
      convRepo,
      orchestrator,
      sendWhatsApp,
      sendWhatsAppMedia,
      mediaService,
      extractorService,
      quoteEngine
    );

    return {
      convRepo,
      leadRepo,
      quoteEngine,
      sendWhatsApp,
      sendWhatsAppMedia,
      orchestrator,
      useCase,
      mockLlm,
    };
  }

  // ─── T93: QUOTATION CON QUOTE_SENT Y RESPUESTA "SI" ANTE FALLO LLM ─────────
  it('T93: Fase QUOTATION, completedSteps incluye QUOTE_SENT, usuario envía "si", LLM lanza HTTP 429 -> Fallback responde con desglose de financiamiento, phase cambia a FINANCING y financingConsentRequested = true', async () => {
    const phone = '5214777026093';
    const harness = createTestHarness({
      llmFails: true,
      llmErrorStatus: 429,
      llmErrorMessage: 'Groq API error 429: 8000 TPM limit reached',
    });

    // 1. Inicializar conversación exactamente en el estado en que falló a las 2:23 p.m.
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor';
    conv.state.monthlyBill = 148228;
    conv.state.bimestralBill = 296456;
    conv.state.roofType = 'concreto';
    conv.state.hasShade = false;
    conv.state.quoteConsentRequested = true;
    conv.state.quoteConsentGiven = true;
    conv.state.completedSteps = ['ROOF_CONFIRMED', 'SHADOWS_ASSESSED', 'QUOTE_SENT'];
    conv.state.phase = 'QUOTATION'; // Como estaba en Firestore
    await harness.convRepo.save(conv);

    // 2. Simular mensaje "si" de Héctor a las 2:23 p.m.
    const result = await harness.useCase.execute({
      tenantId,
      phone,
      text: 'si',
    });

    // 3. Verificaciones de U-First y Cero Intermitencia Técnica
    expect(result.reply).not.toContain('intermitencia técnica');
    expect(result.reply).not.toContain('uno de nuestros asesores continuará atendiéndote');
    expect(result.reply).toContain('Héctor');
    expect(result.reply).toContain('12 meses');
    expect(result.reply).toContain('24 meses');
    expect(result.reply).toContain('36 meses');
    expect(result.reply).toContain('¿Te gustaría que te envíe el brochure oficial con los requisitos');
    expect(result.leadGenerated).toBe(false);

    // 4. Verificación de persistencia y avance de estado
    const savedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(savedConv.state.phase).toBe('FINANCING');
    expect(savedConv.state.financingConsentRequested).toBe(true);
    expect(savedConv.state.financingConsentGiven).toBe(false);
    expect(savedConv.botDisabled).toBe(false);
    expect(harness.sendWhatsApp).toHaveBeenCalledWith(phone, result.reply);
  });

  // ─── T94: QUOTATION CON QUOTE_SENT Y RESPUESTA "AGENDAR VISITA" ANTE FALLO LLM ─
  it('T94: Fase QUOTATION, completedSteps incluye QUOTE_SENT, usuario envía "agendar visita", LLM lanza HTTP 429 -> Fallback transiciona a HUMAN_HANDOFF, botDisabled = true, y se genera lead', async () => {
    const phone = '5214777026094';
    const harness = createTestHarness({
      llmFails: true,
      llmErrorStatus: 429,
      llmErrorMessage: 'Groq API error 429: 8000 TPM limit reached',
    });

    // 1. Conversación en QUOTATION con cotización ya entregada
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor';
    conv.state.monthlyBill = 148228;
    conv.state.roofType = 'concreto';
    conv.state.hasShade = false;
    conv.state.completedSteps = ['ROOF_CONFIRMED', 'SHADOWS_ASSESSED', 'QUOTE_SENT'];
    conv.state.phase = 'QUOTATION';
    await harness.convRepo.save(conv);

    // 2. Usuario elige visita técnica
    const result = await harness.useCase.execute({
      tenantId,
      phone,
      text: 'agendar visita técnica',
    });

    // 3. Verificaciones de Handoff
    expect(result.reply).not.toContain('intermitencia técnica');
    expect(result.reply).toContain('visita técnica gratuita');
    expect(result.leadGenerated).toBe(true);

    // 4. Verificación de estado persistido
    const savedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(savedConv.state.phase).toBe('HUMAN_HANDOFF');
    expect(savedConv.botDisabled).toBe(true);

    const leads = await harness.leadRepo.findAll(tenantId);
    expect(leads.length).toBe(1);
    expect(leads[0].phone).toBe(phone);
  });

  // ─── T95: FINANCING Y CONFIRMACIÓN DE BROCHURE TRAS OFERTA DE MENSUALIDADES ─
  it('T95: Fase FINANCING, financingConsentRequested = true, usuario envía "si", LLM lanza HTTP 429 -> Envía brochure FINANCIAMIENTO.jpeg, transiciona a CLOSING y propone visita', async () => {
    const phone = '5214777026095';
    const harness = createTestHarness({
      llmFails: true,
      llmErrorStatus: 429,
      llmErrorMessage: 'Groq API error 429',
    });

    // 1. Conversación en FINANCING con brochure ya solicitado
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor';
    conv.state.monthlyBill = 148228;
    conv.state.phase = 'FINANCING';
    conv.state.financingConsentRequested = true;
    conv.state.financingConsentGiven = false;
    await harness.convRepo.save(conv);

    // 2. Usuario acepta recibir el brochure
    const result = await harness.useCase.execute({
      tenantId,
      phone,
      text: 'si por favor',
    });

    // 3. Verificaciones de despacho y avance a CLOSING
    expect(result.reply).toContain('Te comparto el brochure oficial');
    expect(result.reply).toContain('visita técnica gratuita');
    expect(harness.sendWhatsAppMedia).toHaveBeenCalledWith(
      phone,
      expect.stringContaining('FINANCIAMIENTO.jpeg'),
      expect.any(String)
    );

    const savedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(savedConv.state.phase).toBe('CLOSING');
    expect(savedConv.state.mediaSentFlags?.financiamiento).toBe(true);
    expect(savedConv.botDisabled).toBe(false);
  });
});

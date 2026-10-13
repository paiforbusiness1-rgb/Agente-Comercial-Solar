/**
 * SofiaForensicApo024.test.ts
 * Batería SQA Forense de Validación Arquitectónica APO-024.
 * Auditoría: Qwen Senior Forensic Auditor & Héctor Álvarez.
 * Mandatos:
 * - T82: Fallback Determinista en FINANCING tras respuesta "si" -> Envía texto + brochure FINANCIAMIENTO.jpeg y avanza a CLOSING.
 * - T83: Fallback Determinista en FINANCING ante preferencia de contado -> Avanza a CLOSING respetando la decisión.
 * - T84: Fallback Determinista en CLOSING ante confirmación de visita técnica -> Transiciona a HUMAN_HANDOFF con botDisabled: true.
 * - T85: Resiliencia de Inferencia Groq a 7000ms (verificación de contrato de timeout).
 * - T86: Idempotencia en FINANCING (Doble "si" concurrentes -> sendWhatsAppMedia llamado exactamente 1 sola vez).
 * - T87: Concurrencia en CLOSING (Doble confirmación de visita -> lead único en leadRepo sin duplicación).
 */

import { describe, it, expect, vi } from 'vitest';
import { ReceiveMessageUseCase } from '../../application/usecases/ReceiveMessageUseCase.js';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { WhatsAppMediaService } from '../../infrastructure/media/WhatsAppMediaService.js';
import { CfeReceiptExtractorService } from '../services/CfeReceiptExtractorService.js';
import { GroqProvider } from '../../infrastructure/llm/GroqProvider.js';

describe('SQA Forense Plan APO-024 — Tests T82 a T87 (Blindaje Determinista FINANCING, CLOSING, Idempotencia y Concurrencia)', () => {
  const tenantId = 'o3energy_mexico';

  function createTestHarness(options?: {
    llmFails?: boolean;
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
          throw new Error(options.llmErrorMessage || 'ETIMEDOUT: LLM API request timed out after 4000ms');
        }
        return {
          text: JSON.stringify({
            next_step: 6,
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

  // ─── T82: FALLBACK DETERMINISTA EN FINANCING TRAS "SI" ──────────────────────
  it('T82: Fallback Determinista en FINANCING tras respuesta "si" ante fallo total de LLM -> Envía texto + brochure FINANCIAMIENTO.jpeg y avanza a CLOSING', async () => {
    const phone = '5214777024082';
    const harness = createTestHarness({ llmFails: true, llmErrorMessage: 'Groq 503 Timeout > 4000ms' });

    // 1. Inicializar conversación en fase FINANCING con consentimiento solicitado
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor Álvarez';
    conv.state.monthlyBill = 148228;
    conv.state.roofType = 'concreto';
    conv.state.phase = 'FINANCING';
    conv.state.financingConsentRequested = true;
    conv.state.financingConsentGiven = false;
    conv.state.mediaSentFlags = { instalacionProfessional: true, financiamiento: false };
    await harness.convRepo.save(conv);

    // 2. Usuario responde afirmativamente al brochure
    const result = await harness.useCase.execute({
      phone,
      tenantId,
      text: 'si',
    });

    // 3. Aserciones de Contrato (Cero intermitencia técnica)
    expect(result.reply).not.toContain('intermitencia');
    expect(result.reply).not.toContain('asesores continuará atendiéndote');
    expect(result.reply).toContain('¡Excelente, Héctor Álvarez! 😊');
    expect(result.reply).toContain('Te comparto el brochure oficial con todos los requisitos y facilidades de financiamiento.');
    expect(result.reply).toContain('visita técnica gratuita de nuestros ingenieros');

    // 4. Verificación de transmisión de texto y archivo multimedia
    expect(harness.sendWhatsApp).toHaveBeenCalledWith(phone, result.reply);
    expect(harness.sendWhatsAppMedia).toHaveBeenCalledWith(
      phone,
      expect.stringContaining('FINANCIAMIENTO.jpeg'),
      'Requisitos y Planes de Financiamiento Solar O3 Energy'
    );

    // 5. Aserción de Estado Persistido
    const updatedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(updatedConv.state.phase).toBe('CLOSING');
    expect(updatedConv.state.financingConsentGiven).toBe(true);
    expect(updatedConv.state.mediaSentFlags.financiamiento).toBe(true);
    expect(updatedConv.botDisabled).toBe(false);
  });

  // ─── T83: FALLBACK DETERMINISTA EN FINANCING ANTE CONTADO ───────────────────
  it('T83: Fallback Determinista en FINANCING ante preferencia de contado ante fallo de LLM -> Avanza a CLOSING respetando la decisión sin enviar brochure', async () => {
    const phone = '5214777024083';
    const harness = createTestHarness({ llmFails: true });

    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor Álvarez';
    conv.state.monthlyBill = 148228;
    conv.state.roofType = 'concreto';
    conv.state.phase = 'FINANCING';
    conv.state.financingConsentRequested = true;
    await harness.convRepo.save(conv);

    const result = await harness.useCase.execute({
      phone,
      tenantId,
      text: 'prefiero de contado',
    });

    expect(result.reply).not.toContain('intermitencia');
    expect(result.reply).toContain('¡Totalmente de acuerdo, Héctor Álvarez!');
    expect(result.reply).toContain('liquidación de contado');
    expect(result.reply).toContain('visita técnica gratuita');
    expect(harness.sendWhatsAppMedia).not.toHaveBeenCalled();

    const updatedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(updatedConv.state.phase).toBe('CLOSING');
    expect(updatedConv.state.financingConsentGiven).toBe(false);
  });

  // ─── T84: FALLBACK DETERMINISTA EN CLOSING ANTE VISITA TÉCNICA ──────────────
  it('T84: Fallback Determinista en CLOSING ante confirmación de visita técnica ante fallo de LLM -> Transiciona a HUMAN_HANDOFF con botDisabled: true y genera lead', async () => {
    const phone = '5214777024084';
    const harness = createTestHarness({ llmFails: true });

    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor Álvarez';
    conv.state.monthlyBill = 148228;
    conv.state.roofType = 'concreto';
    conv.state.phase = 'CLOSING';
    await harness.convRepo.save(conv);

    const result = await harness.useCase.execute({
      phone,
      tenantId,
      text: 'sí, agendemos visita',
    });

    expect(result.reply).not.toContain('intermitencia');
    expect(result.reply).toContain('¡Excelente Héctor Álvarez!');
    expect(result.reply).toContain('asesores especializados de O3 Energy se pondrá en contacto contigo');

    const updatedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(updatedConv.state.phase).toBe('HUMAN_HANDOFF');
    expect(updatedConv.botDisabled).toBe(true);
    expect(result.leadGenerated).toBe(true);

    // Lead registrado en repositorio
    const leads = await harness.leadRepo.findAll(tenantId);
    expect(leads.some((l) => l.phone === phone)).toBe(true);
  });

  // ─── T85: RESILIENCIA DE INFERENCIA GROQ A 7000MS (CONTRATO DE TIMEOUT) ─────
  it('T85: GroqProvider tiene timeout por defecto de 7000ms para evitar falsos positivos de timeout en prompts extensos', () => {
    const defaultProvider = new GroqProvider();
    expect((defaultProvider as any).timeoutMs).toBe(7000);
  });

  // ─── T86: IDEMPOTENCIA EN FINANCING (DOBLE "SI" CON EL MISMO WAMID) ─────────
  it('T86: Idempotencia en FINANCING (Doble mensaje "si" secuencial o reintento de webhook) -> El brochure se envía EXACTAMENTE 1 sola vez', async () => {
    const phone = '5214777024086';
    const harness = createTestHarness({ llmFails: true });

    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor';
    conv.state.monthlyBill = 148228;
    conv.state.phase = 'FINANCING';
    conv.state.financingConsentRequested = true;
    conv.state.mediaSentFlags = { financiamiento: false };
    await harness.convRepo.save(conv);

    // Primer "si": Despacha texto y brochure
    await harness.useCase.execute({
      phone,
      tenantId,
      text: 'si',
    });

    // Segundo "si" (reintento ciego de webhook):
    await harness.useCase.execute({
      phone,
      tenantId,
      text: 'si',
    });

    // Aserción estricta de Idempotencia: sendWhatsAppMedia llamado exactamente 1 sola vez
    expect(harness.sendWhatsAppMedia).toHaveBeenCalledTimes(1);

    const updatedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(updatedConv.state.mediaSentFlags.financiamiento).toBe(true);
  });

  // ─── T87: CONCURRENCIA EN CLOSING (DOBLE CONFIRMACIÓN DE VISITA TÉCNICA) ─────
  it('T87: Concurrencia en CLOSING (Doble confirmación simultánea de visita) -> Genera exactamente 1 lead sin duplicación en CRM', async () => {
    const phone = '5214777024087';
    const harness = createTestHarness({ llmFails: true });

    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor';
    conv.state.monthlyBill = 148228;
    conv.state.phase = 'CLOSING';
    await harness.convRepo.save(conv);

    // Dos peticiones casi simultáneas
    await Promise.all([
      harness.useCase.execute({ phone, tenantId, text: 'agendar visita' }),
      harness.useCase.execute({ phone, tenantId, text: 'agendar visita' }),
    ]);

    const leads = await harness.leadRepo.findAll(tenantId);
    const matchingLeads = leads.filter((l) => l.phone === phone);

    // Aserción estricta de No-Duplicación de Leads (ISO/IEC 27034-1 & Regla 2 HRU)
    expect(matchingLeads.length).toBe(1);
  });
});

/**
 * SofiaForensicApo023.test.ts
 * Batería SQA Forense de Validación Arquitectónica APO-023.
 * Auditoría: Qwen Senior Forensic Auditor & Héctor Álvarez.
 * Mandatos:
 * - T78: Fallback Determinista State-Aware en Relevamiento Técnico ("despejado" ante fallo total de LLM -> Calcula paneles dinámicamente y solicita consentimiento de cotización sin intermitencia).
 * - T79: Fallback Determinista State-Aware en Turno de Techo ("es de lámina" ante fallo de LLM -> Confirma techo y solicita evaluación de sombras).
 * - T80: Fallback Determinista State-Aware en Turno de Cotización ("sí, adelante" ante fallo de LLM -> Despliega propuesta técnica, ROI y ahorro sin intermitencia).
 * - T81: Degradación Elegante Secundario (Fallo de LLM en saludo inicial sin datos -> Mensaje empático seguro sin corromper el repositorio).
 */

import { describe, it, expect, vi } from 'vitest';
import { ReceiveMessageUseCase } from '../../application/usecases/ReceiveMessageUseCase.js';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { WhatsAppMediaService } from '../../infrastructure/media/WhatsAppMediaService.js';
import { CfeReceiptExtractorService } from '../services/CfeReceiptExtractorService.js';

describe('SQA Forense Plan APO-023 — Tests T78 a T81 (Fallback Determinista State-Aware ante Fallos de LLM)', () => {
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
            next_step: 4,
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

  // ─── T78: FALLBACK DETERMINISTA STATE-AWARE ANTE TURNO "DESPEJADO" ───────────
  it('T78: Fallback Determinista en Relevamiento Técnico ("despejado" ante timeout/fallo de LLM) -> Calcula paneles dinámicamente y transiciona a QUOTATION con solicitud de consentimiento', async () => {
    const phone = '5214777023078';
    const harness = createTestHarness({ llmFails: true, llmErrorMessage: 'Groq 503 Service Unavailable / Timeout > 4000ms' });

    // 1. Inicializar conversación con datos completos de facturación y techo en Firestore
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor Álvarez';
    conv.state.monthlyBill = 148228;
    conv.state.billFrequency = 'mensual';
    conv.state.roofType = 'concreto';
    conv.state.phase = 'TECHNICAL_SURVEY';
    conv.state.completedSteps = ['GREETING', 'QUALIFICATION', 'NAME_CONFIRMED', 'BILL_NORMALIZED', 'ROOF_CONFIRMED'];
    await harness.convRepo.save(conv);

    // 2. Simular respuesta del usuario sobre sombras: "despejado"
    const result = await harness.useCase.execute({
      phone,
      tenantId,
      text: 'despejado',
    });

    // 3. Aserciones de Contrato y Regla 4 (U-First / Cero Callejones sin Salida)
    expect(result.reply).not.toContain('intermitencia');
    expect(result.reply).not.toContain('asesores continuará atendiéndote');
    expect(result.reply).toContain('¡Excelente, Héctor Álvarez!');
    expect(result.reply).toContain('techo de concreto y despejado');
    expect(result.reply).toContain('12 paneles solares de alta eficiencia (6.6 kWp)');
    expect(result.reply).toContain('¿Te gustaría que te presente la propuesta preliminar de inversión y ahorro estimado? 😊');

    // 4. Verificación de transmisión por WhatsApp
    expect(harness.sendWhatsApp).toHaveBeenCalledWith(phone, result.reply);

    // 5. Aserción de Estado Persistido en Firestore
    const updatedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(updatedConv.state.phase).toBe('QUOTATION');
    expect(updatedConv.state.hasShade).toBe(false);
    expect(updatedConv.state.shadowsAssessed).toBe(true);
    expect(updatedConv.state.shadows_assessed).toBe(true);
    expect(updatedConv.state.quoteConsentRequested).toBe(true);
    expect(updatedConv.state.completedSteps).toContain('SHADOWS_ASSESSED');
    expect(updatedConv.state.completedSteps).toContain('ROOF_CONFIRMED');

    // 6. El bot sigue activo (no desactivado por handoff)
    expect(updatedConv.botDisabled).toBe(false);
    expect(result.leadGenerated).toBe(false);
  });

  // ─── T79: FALLBACK DETERMINISTA EN TURNO DE TECHO ───────────────────────────
  it('T79: Fallback Determinista en Turno de Techo ("es de concreto" ante fallo de LLM) -> Registra techo y solicita evaluación de sombras sin intermitencia', async () => {
    const phone = '5214777023079';
    const harness = createTestHarness({ llmFails: true });

    // 1. Conversación con recibo normalizado pero pendiente de techo
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor Álvarez';
    conv.state.monthlyBill = 148228;
    conv.state.billFrequency = 'mensual';
    conv.state.phase = 'TECHNICAL_SURVEY';
    conv.state.completedSteps = ['GREETING', 'QUALIFICATION', 'NAME_CONFIRMED', 'BILL_NORMALIZED'];
    await harness.convRepo.save(conv);

    // 2. Usuario indica el tipo de techo
    const result = await harness.useCase.execute({
      phone,
      tenantId,
      text: 'es de concreto',
    });

    // 3. Aserciones
    expect(result.reply).not.toContain('intermitencia');
    expect(result.reply).toContain('Tu techo es de concreto');
    expect(result.reply).toContain('¿hay alguna sombra (árboles, tinacos, edificios u otras estructuras) sobre tu techo, o está completamente despejado? ☀️');

    // 4. Estado persistido
    const updatedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(updatedConv.state.roofType).toBe('concreto');
    expect(updatedConv.state.completedSteps).toContain('ROOF_CONFIRMED');
    expect(updatedConv.state.phase).toBe('TECHNICAL_SURVEY');
  });

  // ─── T80: FALLBACK DETERMINISTA EN TURNO DE COTIZACIÓN ───────────────────────
  it('T80: Fallback Determinista en Turno de Cotización ("sí, por favor" ante fallo de LLM) -> Entrega propuesta técnica con ROI y ahorro calculado por SolarQuoteEngine', async () => {
    const phone = '5214777023080';
    const harness = createTestHarness({ llmFails: true });

    // 1. Conversación en fase QUOTATION esperando consentimiento
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor Álvarez';
    conv.state.monthlyBill = 148228;
    conv.state.billFrequency = 'mensual';
    conv.state.roofType = 'concreto';
    conv.state.hasShade = false;
    conv.state.shadowsAssessed = true;
    conv.state.phase = 'QUOTATION';
    conv.state.quoteConsentRequested = true;
    conv.state.completedSteps = ['GREETING', 'QUALIFICATION', 'BILL_NORMALIZED', 'ROOF_CONFIRMED', 'SHADOWS_ASSESSED'];
    await harness.convRepo.save(conv);

    // 2. Usuario da el consentimiento explícito
    const result = await harness.useCase.execute({
      phone,
      tenantId,
      text: 'sí, por favor',
    });

    // 3. Aserciones de Contrato
    expect(result.reply).not.toContain('intermitencia');
    expect(result.reply).toContain('¡Con mucho gusto, Héctor Álvarez!');
    expect(result.reply).toContain('12 paneles solares de alta eficiencia (6.6 kWp)');
    expect(result.reply).toContain('$77,700 MXN (IVA incluido)');
    expect(result.reply).toContain('$133,405 MXN al mes');
    expect(result.reply).toContain('¿Te gustaría conocer nuestras opciones de financiamiento');

    // 4. Estado persistido
    const updatedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(updatedConv.state.quoteConsentGiven).toBe(true);
    expect(updatedConv.state.completedSteps).toContain('QUOTE_SENT');
  });

  // ─── T81: DEGRADACIÓN ELEGANTE SECUNDARIA (SIN DATOS PREVIOS) ─────────────────
  it('T81: Degradación Elegante Secundaria (Fallo de LLM en saludo inicial sin recibo) -> Mensaje empático seguro sin corromper el repositorio', async () => {
    const phone = '5214777023081';
    const harness = createTestHarness({ llmFails: true });

    const result = await harness.useCase.execute({
      phone,
      tenantId,
      text: 'Hola, buenas tardes',
    });

    // Sin recibo ni datos técnicos, emite el fallback empático controlado
    expect(result.reply).toContain('¡Hola! 😊 Recibí tu mensaje.');
    expect(result.reply).toContain('pequeña intermitencia técnica');
    expect(harness.sendWhatsApp).toHaveBeenCalledWith(phone, result.reply);

    const updatedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(updatedConv.messages.length).toBe(2); // user + bot
    expect(updatedConv.messages[0].text).toBe('Hola, buenas tardes');
    expect(updatedConv.messages[1].text).toContain('intermitencia técnica');
  });
});

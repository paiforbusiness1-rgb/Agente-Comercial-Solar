/**
 * SofiaForensicApo025.test.ts
 * Batería SQA Forense de Validación Arquitectónica APO-025.
 * Auditoría: Qwen Senior Forensic Auditor & Héctor Álvarez.
 * Mandatos:
 * - T88: Mock HTTP 429 en QUALIFICATION con intención de espera ("te comparto los recibos aguarda!") -> Respuesta empática determinista sin "intermitencia técnica".
 * - T89: Monto en texto en QUALIFICATION ante fallo de LLM ("pago $3,500 al bimestre") -> Normalización determinista y transición a TECHNICAL_SURVEY.
 * - T90: Nombre en GREETING ante fallo de LLM ("Hola soy Carlos") -> Extracción determinista y transición a QUALIFICATION.
 * - T91: Failover Inmediato 0ms ante HTTP 429 en ResilientLLMProvider -> Trip inmediato de circuito Groq a OPEN y delegación a Gemini.
 * - T92: Resiliencia ante múltiples expresiones coloquiales de espera en QUALIFICATION sin rendición.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReceiveMessageUseCase } from '../../application/usecases/ReceiveMessageUseCase.js';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { WhatsAppMediaService } from '../../infrastructure/media/WhatsAppMediaService.js';
import { CfeReceiptExtractorService } from '../services/CfeReceiptExtractorService.js';
import { ResilientLLMProvider } from '../../infrastructure/llm/ResilientLLMProvider.js';
import { LLMCircuitBreaker } from '../../infrastructure/llm/LLMCircuitBreaker.js';

describe('SQA Forense Plan APO-025 — Tests T88 a T92 (Blindaje Universal Pasos 1 a 6, Failover Inmediato 0ms ante HTTP 429 y Mitigación de TPM)', () => {
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
            next_step: 2,
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

  // ─── T88: MOCK HTTP 429 EN QUALIFICATION CON INTENCIÓN DE ESPERA ──────────
  it('T88: Mock HTTP 429 en QUALIFICATION con intención de espera ("te comparto los recibos aguarda!") -> Sofía responde con calidez y paciencia sin decir "intermitencia técnica"', async () => {
    const phone = '5214777025088';
    const harness = createTestHarness({
      llmFails: true,
      llmErrorStatus: 429,
      llmErrorMessage: 'Groq API error 429: Rate limit exceeded. 8000 TPM limit reached.',
    });

    // 1. Inicializar conversación en fase QUALIFICATION tras haber pedido el recibo
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor';
    conv.state.phase = 'QUALIFICATION';
    conv.state.mediaSentFlags = { instalacionProfessional: true };
    await harness.convRepo.save(conv);

    // 2. Simular mensaje del usuario avisando que va por los recibos
    const result = await harness.useCase.execute({
      tenantId,
      phone,
      text: 'te comparto los recibos aguarda!',
    });

    // 3. Verificaciones de U-First y Cero Rendición
    expect(result.reply).not.toContain('intermitencia técnica');
    expect(result.reply).not.toContain('uno de nuestros asesores continuará atendiéndote');
    expect(result.reply).toContain('Héctor');
    expect(result.reply).toContain('Quedo a la espera de tus recibos CFE');
    expect(result.leadGenerated).toBe(false);

    // 4. Verificar persistencia en Firestore
    const savedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(savedConv.state.phase).toBe('QUALIFICATION');
    expect(savedConv.botDisabled).toBe(false);
    expect(savedConv.messages[savedConv.messages.length - 1].text).toBe(result.reply);
    expect(harness.sendWhatsApp).toHaveBeenCalledWith(phone, result.reply);
  });

  // ─── T89: MONTO EN TEXTO EN QUALIFICATION ANTE FALLO LLM ──────────────────
  it('T89: Monto en texto en QUALIFICATION ("pago $3,500 al bimestre") ante fallo total de LLM -> Normaliza y transiciona deterministamente a TECHNICAL_SURVEY', async () => {
    const phone = '5214777025089';
    const harness = createTestHarness({
      llmFails: true,
      llmErrorStatus: 429,
      llmErrorMessage: 'Groq API error 429: Rate limit exceeded.',
    });

    // 1. Conversación en QUALIFICATION
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Carlos';
    conv.state.phase = 'QUALIFICATION';
    await harness.convRepo.save(conv);

    // 2. Usuario indica su monto en texto
    const result = await harness.useCase.execute({
      tenantId,
      phone,
      text: 'pago $3,500 al bimestre',
    });

    // 3. Verificaciones deterministas
    expect(result.reply).not.toContain('intermitencia técnica');
    expect(result.reply).toContain('Carlos');
    expect(result.reply).toContain('$3,500 MXN (bimestral)');
    expect(result.reply).toContain('¿podrías indicarme qué tipo de techo tienes');

    // 4. Verificar estado matemático
    const savedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(savedConv.state.phase).toBe('TECHNICAL_SURVEY');
    expect(savedConv.state.bimestralBill).toBe(3500);
    expect(savedConv.state.monthlyBill).toBe(1750);
    expect(savedConv.state.completedSteps).toContain('BILL_NORMALIZED');
  });

  // ─── T90: NOMBRE DE USUARIO EN GREETING ANTE FALLO LLM ────────────────────
  it('T90: Nombre de usuario en GREETING ("Hola soy Carlos") ante fallo total de LLM -> Extrae nombre y transiciona a QUALIFICATION solicitando recibo', async () => {
    const phone = '5214777025090';
    const harness = createTestHarness({
      llmFails: true,
      llmErrorStatus: 503,
      llmErrorMessage: 'Service Unavailable',
    });

    // 1. Conversación en GREETING con nombre genérico 'Cliente'
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Cliente';
    conv.state.phase = 'GREETING';
    await harness.convRepo.save(conv);

    // 2. Usuario se presenta
    const result = await harness.useCase.execute({
      tenantId,
      phone,
      text: 'Hola soy Carlos',
    });

    // 3. Verificaciones deterministas
    expect(result.reply).not.toContain('intermitencia técnica');
    expect(result.reply).toContain('¡Hola Carlos!');
    expect(result.reply).toContain('monto aproximado de tu recibo de luz');

    // 4. Verificar estado persistido
    const savedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(savedConv.nombre).toBe('Carlos');
    expect(savedConv.state.phase).toBe('QUALIFICATION');
    expect(savedConv.botDisabled).toBe(false);
  });

  // ─── T91: FAILOVER INMEDIATO 0MS ANTE HTTP 429 EN RESILIENTLLMPROVIDER ───
  it('T91: Failover Inmediato 0ms ante HTTP 429 en ResilientLLMProvider -> Tripea circuito Groq a OPEN inmediatamente y resuelve con Gemini', async () => {
    const groqCircuit = new LLMCircuitBreaker({ name: 'Groq-Test', failureThreshold: 2, cooldownMs: 60000 });
    const geminiCircuit = new LLMCircuitBreaker({ name: 'Gemini-Test', failureThreshold: 2, cooldownMs: 60000 });

    const mockGroq = {
      complete: vi.fn().mockImplementation(async () => {
        const err = new Error('Groq API error 429: Rate limit exceeded (8000 TPM)');
        (err as any).status = 429;
        throw err;
      }),
    };

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        return {
          ok: true,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ next_step: 2, message_to_user: 'Respuesta generada por Gemini 2.5 Flash' }) }],
                },
              },
            ],
          }),
        };
      }
      return { ok: false, status: 500 };
    });

    const resilientProvider = new ResilientLLMProvider(
      mockGroq as any,
      mockFetch as any,
      3500,
      { groq: groqCircuit, gemini: geminiCircuit }
    );

    expect(groqCircuit.isOpen()).toBe(false);

    // Ejecución de llamada ante 429 de Groq
    const response = await resilientProvider.complete(
      [
        { role: 'system', content: 'Eres Sofía' },
        { role: 'user', content: '<phone>5214777025091</phone> Mensaje del usuario' },
      ],
      [],
      0.2
    );

    // 1. Debe haber resuelto exitosamente vía Gemini
    expect(response.text).toContain('Respuesta generada por Gemini 2.5 Flash');

    // 2. El circuito de Groq debe haber quedado en OPEN instantáneamente (trip forzado por 429)
    expect(groqCircuit.isOpen()).toBe(true);

    // 3. Siguiente llamada: GroqProvider NI SIQUIERA DEBE SER LLAMADO (0ms bypass)
    mockGroq.complete.mockClear();
    const secondResponse = await resilientProvider.complete(
      [
        { role: 'system', content: 'Eres Sofía' },
        { role: 'user', content: '<phone>5214777025091</phone> Segundo mensaje rápido' },
      ],
      [],
      0.2
    );

    expect(mockGroq.complete).not.toHaveBeenCalled();
    expect(secondResponse.text).toContain('Respuesta generada por Gemini 2.5 Flash');
  });

  // ─── T92: RESILIENCIA ANTE MÚLTIPLES EXPRESIONES DE ESPERA EN QUALIFICATION ─
  it('T92: Resiliencia ante diversas expresiones coloquiales de espera ("dame un momento", "voy por ellos", "ahi van") -> Sofía responde deterministamente sin rendirse', async () => {
    const expressions = [
      'dame un momento por favor',
      'espera que los estoy buscando',
      'ahi van',
      'voy por ellos',
      'ya te los paso',
    ];

    for (let i = 0; i < expressions.length; i++) {
      const phone = `5214777025092${i}`;
      const harness = createTestHarness({
        llmFails: true,
        llmErrorStatus: 429,
        llmErrorMessage: 'Groq 429 Too Many Requests',
      });

      const conv = await harness.convRepo.findByPhone(tenantId, phone);
      conv.nombre = 'Héctor';
      conv.state.phase = 'QUALIFICATION';
      await harness.convRepo.save(conv);

      const result = await harness.useCase.execute({
        tenantId,
        phone,
        text: expressions[i],
      });

      expect(result.reply).not.toContain('intermitencia técnica');
      expect(result.reply).toContain('Héctor');
      expect(result.reply).toContain('Quedo a la espera de tus recibos CFE');
      expect(result.leadGenerated).toBe(false);
    }
  });
});

/**
 * SofiaForensicApo017.test.ts
 * Suite de Pruebas de Calidad de Software (SQA) — Plan de Mitigación Forense APO-017.
 * Auditoría: Qwen Senior Forensic Auditor & Héctor (Mandatos T53 a T57).
 * 
 * Cobertura de Escenarios:
 * - T53 (Manejo Empático de ??): Salida de baja fricción ante dudas en Paso 3, sin asunción ciega.
 * - T54 (Desacoplamiento de Paso 3): Preguntas técnicas secuenciales sin sobrecarga cognitiva.
 * - T55 (Timeout y Fallback con Observabilidad): Timeout en Groq -> failover a Gemini 2.5 Flash con logger.warn.
 * - T56 (Fidelidad de Timestamps Inbound): Propagación estricta de msg.timestamp de Meta a la BD.
 * - T57 (Regresión Total y Contrato de Resiliencia): Paridad de ILLMProvider y estabilidad operativa.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReceiveMessageUseCase } from '../../application/usecases/ReceiveMessageUseCase.js';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { ILLMProvider } from '../../interfaces/ILLMProvider.js';
import { ResilientLLMProvider } from '../../infrastructure/llm/ResilientLLMProvider.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';

describe('SQA Forense Plan APO-017 — Tests T53 a T57 (Erradicación de Fricción Conversacional, Resiliencia LLM y Fidelidad de Timestamps)', () => {
  const tenantId = 'o3energy_mexico';

  function createHarness(deps?: {
    llmResponses?: any[];
    customLlmProvider?: ILLMProvider;
  }) {
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();
    const sendWhatsApp = vi.fn().mockResolvedValue(true);
    const sendWhatsAppMedia = vi.fn().mockResolvedValue(true);

    let mockLlm: ILLMProvider;

    if (deps?.customLlmProvider) {
      mockLlm = deps.customLlmProvider;
    } else {
      mockLlm = {
        complete: vi.fn(),
      };

      if (deps?.llmResponses && deps.llmResponses.length > 0) {
        deps.llmResponses.forEach((resp) => {
          (mockLlm.complete as any).mockResolvedValueOnce({
            text: typeof resp === 'string' ? resp : JSON.stringify(resp),
            finishReason: 'stop',
            toolCalls: [],
          });
        });
        (mockLlm.complete as any).mockResolvedValue({
          text: JSON.stringify({
            next_step: 4,
            message_to_user: '¡Perfecto!',
            extracted_data: {},
            quote_consent_given: true,
          }),
          finishReason: 'stop',
          toolCalls: [],
        });
      } else {
        (mockLlm.complete as any).mockResolvedValue({
          text: JSON.stringify({
            next_step: 3,
            message_to_user: '¿De qué material es tu techo?',
            extracted_data: {},
          }),
          finishReason: 'stop',
          toolCalls: [],
        });
      }
    }

    const orchestrator = new SofiaFlowOrchestrator(
      convRepo,
      leadRepo,
      quoteEngine,
      mockLlm,
      sendWhatsApp,
      { sendLeadEmailNotification: vi.fn().mockResolvedValue(true) } as any
    );

    const useCase = new ReceiveMessageUseCase(
      convRepo,
      orchestrator,
      sendWhatsApp,
      sendWhatsAppMedia
    );

    return {
      convRepo,
      leadRepo,
      quoteEngine,
      sendWhatsApp,
      sendWhatsAppMedia,
      mockLlm,
      orchestrator,
      useCase,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // T53: Manejo Empático de "??" (Refinamiento 1 — Salida de Baja Fricción)
  // ──────────────────────────────────────────────────────────────────────────
  it('T53 (Manejo Empático de ??): Ofrece salida de baja fricción con confirmación explícita sin asumir a ciegas', async () => {
    const phone = '5214777871635';
    const harness = createHarness({
      llmResponses: [
        {
          next_step: 3,
          message_to_user: '¡Entendido, techo de concreto! ¿Hay sombras de árboles o tinacos durante el día?',
          extracted_data: { roof_type: 'concreto', shadows_status: 'unknown' },
        },
      ],
    });

    // 1. Preparar conversación en estado similar al de Juan Manuel
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Juan Manuel';
    conv.state.monthlyBill = 600;
    conv.state.bimestralBill = 1200;
    conv.state.roofType = 'concreto';
    conv.state.shadowsAssessed = false;
    conv.state.phase = 'TECHNICAL_SURVEY';
    conv.messages.push({
      sender: 'bot',
      text: '¡Excelente, techo de concreto! 🏠 ¿Hay sombras de árboles, tinacos, edificios u otras estructuras que lleguen a tu techo durante el día?',
      timestamp: new Date().toISOString(),
    });
    await harness.convRepo.save(conv);

    // 2. El usuario envía "??" ante la pausa o confusión
    const result1 = await harness.useCase.execute({
      phone,
      text: '??',
      name: 'Juan Manuel',
    });

    // Aserciones estrictas de Refinamiento 1 (U-First):
    expect(result1.reply).toContain('Aquí sigo contigo, Juan Manuel! 😊');
    expect(result1.reply).toContain('Disculpa si me trabé');
    expect(result1.reply).toContain('podemos asumir que está despejado y nuestros ingenieros lo confirman en la visita gratuita');
    expect(result1.reply).toContain('¿Te parece bien?');

    // Validación de seguridad (SSD): NO asumió a ciegas
    const convAfterQuestion = await harness.convRepo.findByPhone(tenantId, phone);
    expect(convAfterQuestion.state.shadowsAssessed).toBe(false);

    // 3. El usuario responde afirmativamente ("Sí") confirmando la propuesta de baja fricción
    const result2 = await harness.useCase.execute({
      phone,
      text: 'Sí',
      name: 'Juan Manuel',
    });

    // Ahora sí se valida sin sombras y avanza hacia la cotización
    const convAfterConfirm = await harness.convRepo.findByPhone(tenantId, phone);
    expect(convAfterConfirm.state.hasShade).toBe(false);
    expect(convAfterConfirm.state.shadowsAssessed).toBe(true);
    expect(result2.reply).toContain('Asumimos techo despejado por ahora');
    expect(result2.reply).toContain('PRESUPUESTO PRELIMINAR');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T54: Desacoplamiento Secuencial de Paso 3 (Regla 4: U-First)
  // ──────────────────────────────────────────────────────────────────────────
  it('T54 (Desacoplamiento de Paso 3): Solicita techo primero, y luego sombras con opción despejado ☀️', async () => {
    const phone = '5214777000054';
    const harness = createHarness({
      llmResponses: [
        // Turno 1: Recibe recibo y pregunta SOLO por el tipo de techo
        {
          next_step: 3,
          message_to_user: 'Para diseñar la solución ideal para ti, ¿qué tipo de techo tienes en tu propiedad (concreto, lámina o teja)? 🏢',
          extracted_data: { bill_amount: 1200, bill_frequency: 'bimestral' },
        },
        // Turno 2: Recibe tipo de techo y pregunta por sombras con opción rápida
        {
          next_step: 4, // LLM intenta saltar prematuramente a 4
          message_to_user: '¡Excelente!',
          extracted_data: { roof_type: 'concreto' },
        },
      ],
    });

    // Turno 1: Ingreso de recibo
    const res1 = await harness.useCase.execute({
      phone,
      text: '1200 bimestral',
      name: 'Carlos',
    });

    expect(res1.reply).toContain('¿qué tipo de techo tienes');
    expect(res1.reply).not.toContain('sombras'); // No satura al usuario

    // Turno 2: Respuesta de tipo de techo ("concreto")
    const res2 = await harness.useCase.execute({
      phone,
      text: 'concreto',
      name: 'Carlos',
    });

    // El orquestador intercepta y desacopla con la pregunta de sombras amigable
    expect(res2.reply).toContain('techo de concreto');
    expect(res2.reply).toContain('¿hay alguna sobre tu techo, o está completamente despejado? ☀️');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T55: Timeout y Fallback con Observabilidad (Refinamiento 2 — Regla 6: SSD)
  // ──────────────────────────────────────────────────────────────────────────
  it('T55 (Timeout y Fallback con Observabilidad): Conmuta a Gemini ante falla/timeout de Groq y emite logger.warn', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');

    // 1. Mock de Groq que falla por timeout o 429
    const mockFailingGroq: ILLMProvider = {
      complete: vi.fn().mockRejectedValue(new Error('Groq Timeout after 7000ms (AbortError)')),
    };

    // 2. Mock de Gemini Fallback exitoso
    const geminiMockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    next_step: 3,
                    message_to_user: '¡Hola! Soy Sofía vía respaldo resiliente.',
                    extracted_data: {},
                  }),
                },
              ],
            },
          },
        ],
      }),
    });

    const resilientProvider = new ResilientLLMProvider(
      mockFailingGroq,
      geminiMockFetch as any,
      1000 // Timeout corto para test
    );

    // Forzar presencia de API key en config simulado
    vi.stubEnv('GEMINI_API_KEY', 'mock-gemini-test-key-2026');

    const promptMessages = [
      { role: 'system' as const, content: 'Eres Sofía.' },
      { role: 'user' as const, content: '<phone>5214777871635</phone>\nHola' },
    ];

    const startTime = Date.now();
    const response = await resilientProvider.complete(promptMessages);
    const elapsed = Date.now() - startTime;

    // Aserciones de Refinamiento 2:
    expect(response.text).toContain('¡Hola! Soy Sofía vía respaldo resiliente.');
    expect(elapsed).toBeLessThan(8000);

    // Observabilidad obligatoria: logger.warn llamado con teléfono
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ResilientLLM] Groq timeout/failure detected. Failing over to Gemini 2.5 Flash for phone: 5214777871635'),
      expect.objectContaining({ error: expect.stringContaining('Groq Timeout') })
    );

    warnSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T56: Fidelidad de Timestamps Inbound de Meta (Refinamiento 3 — Regla 2: HRU)
  // ──────────────────────────────────────────────────────────────────────────
  it('T56 (Fidelidad de Timestamps): Preserva el inboundTimestamp original de Meta en los mensajes del usuario', async () => {
    const phone = '5214777000056';
    const harness = createHarness();

    // Timestamp de Meta de hace 3 minutos
    const metaTimestamp = '2026-10-12T17:19:23.000Z';

    await harness.useCase.execute({
      phone,
      text: 'Buenos días',
      name: 'Juan Manuel',
      inboundTimestamp: metaTimestamp,
    });

    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    const userMsg = conv.messages.find((m) => m.sender === 'user');
    const botMsg = conv.messages.find((m) => m.sender === 'bot');

    expect(userMsg).toBeDefined();
    expect(botMsg).toBeDefined();

    // El mensaje del usuario DEBE coincidir con el tiempo exacto en que se originó en Meta
    expect(userMsg?.timestamp).toBe(metaTimestamp);

    // El mensaje del bot DEBE ser el timestamp actual de despacho, no el timestamp antiguo
    expect(botMsg?.timestamp).not.toBe(metaTimestamp);
    expect(new Date(botMsg!.timestamp).getTime()).toBeGreaterThanOrEqual(new Date(metaTimestamp).getTime());
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T57: Regresión Total y Contrato de Resiliencia (Reglas 1, 2 y 5: SQA)
  // ──────────────────────────────────────────────────────────────────────────
  it('T57 (Regresión Total y Contrato): ResilientLLMProvider preserva la ejecución primaria cuando Groq responde con éxito', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');

    const mockWorkingGroq: ILLMProvider = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({ next_step: 2, message_to_user: 'Respuesta primaria exitosa' }),
        finishReason: 'stop',
        toolCalls: [],
      }),
    };

    const resilientProvider = new ResilientLLMProvider(mockWorkingGroq);

    const res = await resilientProvider.complete([
      { role: 'system', content: 'Eres Sofía' },
      { role: 'user', content: '<phone>5214777871635</phone>\nHola' },
    ]);

    expect(res.text).toContain('Respuesta primaria exitosa');
    // Si Groq tuvo éxito, NO debe registrarse ningún warn de fallback
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

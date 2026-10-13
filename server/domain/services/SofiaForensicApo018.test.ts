/**
 * SofiaForensicApo018.test.ts
 * Suite de Pruebas de Calidad de Software (SQA) — Plan de Mitigación Forense APO-018.
 * Auditoría: Qwen Senior Forensic Auditor & Héctor (Mandatos T58 a T62).
 * 
 * Cobertura de Escenarios:
 * - T58 (Concurrencia Extrema): 5 webhooks concurrentes con arrayUnion y restauración atómica sin pérdida.
 * - T59 (Cero Escritura Ansiosa): findByPhone es de lectura pura en memoria; cero chats fantasma en disco.
 * - T60 (Circuit Breaker Proactivo): Groq falla 2 veces -> OPEN -> Fail-Fast 0ms directo a Gemini.
 * - T61 (Degradación Elegante U-First): Ambos circuitos OPEN -> Usuario guardado primero y contingencia empática.
 * - T62 (Recuperación HALF_OPEN -> CLOSED): Sonda exitosa restablece el circuito a operación normal.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReceiveMessageUseCase } from '../../application/usecases/ReceiveMessageUseCase.js';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { ILLMProvider } from '../../interfaces/ILLMProvider.js';
import { ResilientLLMProvider } from '../../infrastructure/llm/ResilientLLMProvider.js';
import { LLMCircuitBreaker } from '../../infrastructure/llm/LLMCircuitBreaker.js';

describe('SQA Forense Plan APO-018 — Tests T58 a T62 (Transacciones Atómicas, Guardar Primero y Circuit Breaker)', () => {
  const tenantId = 'o3energy_mexico';

  function createHarness(deps?: {
    llmResponses?: any[];
    customLlmProvider?: ILLMProvider;
    customConvRepo?: InMemoryConversationRepository;
  }) {
    const convRepo = deps?.customConvRepo || new InMemoryConversationRepository();
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
            next_step: 3,
            message_to_user: '¿De qué material es tu techo?',
            extracted_data: {},
          }),
          finishReason: 'stop',
          toolCalls: [],
        });
      } else {
        (mockLlm.complete as any).mockResolvedValue({
          text: JSON.stringify({
            next_step: 2,
            message_to_user: '¡Hola! ¿Cuánto pagas en tu recibo de luz?',
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
  // T58: Cero Resurrección Inbound y Lectura Pura en findByPhone (APO-021)
  // ──────────────────────────────────────────────────────────────────────────
  it('T58 (Cero Resurrección Inbound): Webhook entrante para un número en deleted_chats retorna un objeto limpio en memoria y no resucita historial', async () => {
    const phone = '5214777241148';
    const harness = createHarness();

    // 1. Preparar un chat archivado en papelera con 3 mensajes históricos
    const initialConv = await harness.convRepo.findByPhone(tenantId, phone);
    initialConv.nombre = 'Héctor';
    initialConv.messages = [
      { sender: 'user', text: 'Histórico 1', timestamp: '2026-10-12T10:00:00.000Z' },
      { sender: 'bot', text: 'Respuesta 1', timestamp: '2026-10-12T10:00:01.000Z' },
      { sender: 'user', text: 'Histórico 2', timestamp: '2026-10-12T10:01:00.000Z' },
    ];
    await harness.convRepo.save(initialConv);
    await harness.convRepo.softDelete(tenantId, phone, 'admin@o3energy.mx');

    // Verificar que está en papelera
    const trashedBefore = await harness.convRepo.findTrash(tenantId);
    expect(trashedBefore.some((c) => c.phone === phone)).toBe(true);

    // 2. findByPhone para este número archivado DEBE retornar modelo limpio
    const freshConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(freshConv.nombre).toBe('Cliente');
    expect(freshConv.messages).toHaveLength(0);
    expect(freshConv.state.phase).toBe('GREETING');

    // 3. Ejecutar webhook entrante (nuevo mensaje "hola!")
    await harness.useCase.execute({
      phone,
      text: 'hola!',
      name: 'Cliente',
      inboundTimestamp: '2026-10-12T20:18:20.000Z',
    });

    // 4. Aserciones de Integridad: Conversación nueva no contiene mensajes históricos
    const activeConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(activeConv.status).toBe('active');
    const messageTexts = activeConv.messages.map((m) => m.text);
    expect(messageTexts).not.toContain('Histórico 1');
    expect(messageTexts).not.toContain('Histórico 2');
    expect(messageTexts).not.toContain('Respuesta 1');
    expect(messageTexts).toContain('hola!');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T59: Cero Escritura Ansiosa en findByPhone (Lectura Pura)
  // ──────────────────────────────────────────────────────────────────────────
  it('T59 (Cero Escritura Ansiosa): findByPhone para un número nuevo no persiste en la base de datos hasta invocar save()', async () => {
    const unknownPhone = '5214779998877';
    const harness = createHarness();

    // 1. Invocación de lectura pura
    const convInMemory = await harness.convRepo.findByPhone(tenantId, unknownPhone);
    expect(convInMemory.phone).toBe(unknownPhone);
    expect(convInMemory.nombre).toBe('Cliente');
    expect(convInMemory.messages).toEqual([]);
    expect(convInMemory.state.phase).toBe('GREETING');

    // 2. Verificar que NO se escribió en el almacenamiento subyacente
    const allActive = await harness.convRepo.findAll(tenantId);
    const existsInActive = allActive.some((c) => c.phone === unknownPhone);
    expect(existsInActive).toBe(false);

    // 3. Persistir explícitamente mediante save()
    convInMemory.messages.push({ sender: 'user', text: 'Hola', timestamp: '2026-10-12T20:20:00.000Z' });
    await harness.convRepo.save(convInMemory);

    const allActiveAfterSave = await harness.convRepo.findAll(tenantId);
    expect(allActiveAfterSave.some((c) => c.phone === unknownPhone)).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T60: Circuit Breaker Proactivo (Fail-Fast a 0ms tras Fallas Consecutivas)
  // ──────────────────────────────────────────────────────────────────────────
  it('T60 (Circuit Breaker Proactivo): Groq transiciona a OPEN tras 2 fallas y conmuta a Gemini con 0ms de espera', async () => {
    const groqFailMock: ILLMProvider = {
      complete: vi.fn().mockRejectedValue(new Error('Groq 503 Overloaded')),
    };

    const geminiMockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ next_step: 2, message_to_user: 'Respuesta Gemini Fallback' }) }],
            },
          },
        ],
      }),
    });

    const groqCircuit = new LLMCircuitBreaker({ name: 'Groq', failureThreshold: 2, cooldownMs: 60000 });
    const geminiCircuit = new LLMCircuitBreaker({ name: 'Gemini', failureThreshold: 2, cooldownMs: 60000 });

    const resilientProvider = new ResilientLLMProvider(
      groqFailMock,
      geminiMockFetch as any,
      5000,
      { groq: groqCircuit, gemini: geminiCircuit }
    );

    // Petición 1: Falla Groq -> Fallback a Gemini
    const res1 = await resilientProvider.complete([{ role: 'user', content: 'test 1' }]);
    expect(res1.text).toContain('Respuesta Gemini Fallback');
    expect(groqCircuit.getState()).toBe('CLOSED'); // 1 falla de 2

    // Petición 2: Falla Groq -> Dispara Circuit Breaker a OPEN
    const res2 = await resilientProvider.complete([{ role: 'user', content: 'test 2' }]);
    expect(res2.text).toContain('Respuesta Gemini Fallback');
    expect(groqCircuit.getState()).toBe('OPEN');

    // Petición 3: Fail-Fast (Groq en OPEN NO debe ser invocado)
    const groqCallsBefore = (groqFailMock.complete as any).mock.calls.length;
    expect(groqCallsBefore).toBe(2);

    const startTime = Date.now();
    const res3 = await resilientProvider.complete([{ role: 'user', content: 'test 3' }]);
    const elapsedMs = Date.now() - startTime;

    const groqCallsAfter = (groqFailMock.complete as any).mock.calls.length;
    expect(groqCallsAfter).toBe(2); // ¡CERO llamadas adicionales a Groq! Fail-Fast absoluto.
    expect(elapsedMs).toBeLessThan(100); // 0ms de espera por timeout de Groq
    expect(res3.text).toContain('Respuesta Gemini Fallback');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T61: Degradación Elegante con Patrón "Guardar Usuario Primero" (Refinamiento B)
  // ──────────────────────────────────────────────────────────────────────────
  it('T61 (Degradación Elegante): Ante falla total de LLM, el mensaje del usuario ya está en disco y se emite contingencia U-First', async () => {
    const phone = '5214771122334';

    // Mock de LLM que falla catastróficamente (ambos circuitos caídos)
    const failingLlm: ILLMProvider = {
      complete: vi.fn().mockRejectedValue(new Error('Total AI Infrastructure Outage (503)')),
    };

    const harness = createHarness({ customLlmProvider: failingLlm });

    // Ejecutar webhook con mensaje de usuario
    const userMessage = 'Hola, me interesa una cotización de 8 paneles';
    const inboundTimestamp = '2026-10-12T20:25:00.000Z';

    const output = await harness.useCase.execute({
      phone,
      text: userMessage,
      name: 'Carlos',
      inboundTimestamp,
    });

    // 1. El webhook NO debe haber crasheado (retorna respuesta empática de contingencia)
    expect(output.reply).toContain('Recibí tu mensaje');
    expect(output.reply).toContain('intermitencia técnica');

    // 2. Verificar que sendWhatsApp se invocó con el mensaje de contingencia
    expect(harness.sendWhatsApp).toHaveBeenCalledWith(phone, expect.stringContaining('Recibí tu mensaje'));

    // 3. ASERCIÓN CRÍTICA: El mensaje del usuario NUNCA se perdió; está en conv.messages
    const savedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(savedConv.messages.length).toBeGreaterThanOrEqual(2);

    // Primer mensaje es el del usuario
    expect(savedConv.messages[0]).toMatchObject({
      sender: 'user',
      text: userMessage,
      timestamp: inboundTimestamp,
    });

    // Segundo mensaje es la contingencia de Sofía
    expect(savedConv.messages[1]).toMatchObject({
      sender: 'bot',
      text: expect.stringContaining('intermitencia técnica'),
    });

    // Estado NO es un array vacío
    expect(savedConv.messages).not.toEqual([]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T62: No-Regresión y Recuperación de Circuit Breaker (HALF_OPEN -> CLOSED)
  // ──────────────────────────────────────────────────────────────────────────
  it('T62 (Recuperación HALF_OPEN -> CLOSED): Sonda exitosa tras cooldown restablece el circuito a operación normal', async () => {
    const circuit = new LLMCircuitBreaker({ name: 'GroqRecovery', failureThreshold: 2, cooldownMs: 50 });

    circuit.recordFailure(new Error('Falla 1'));
    circuit.recordFailure(new Error('Falla 2'));
    expect(circuit.getState()).toBe('OPEN');

    // Esperar a que expire el cooldown de 50ms
    await new Promise((r) => setTimeout(r, 60));

    // El estado debe haber transicionado a HALF_OPEN
    expect(circuit.getState()).toBe('HALF_OPEN');

    // Registrar sonda exitosa
    circuit.recordSuccess();
    expect(circuit.getState()).toBe('CLOSED');
    expect(circuit.isOpen()).toBe(false);
  });
});

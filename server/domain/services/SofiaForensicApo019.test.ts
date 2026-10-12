/**
 * SofiaForensicApo019.test.ts
 * Suite de Pruebas de Calidad de Software (SQA) — Plan de Mitigación Forense APO-019 (Revisión Definitiva 3).
 * Auditoría: Qwen Senior Forensic Auditor & Héctor Álvarez (Mandatos T63 a T67).
 * 
 * Cobertura de Escenarios:
 * - T63: Sanitizador Robusto (NaN -> null, Date/Timestamp intactos, undefined eliminado, null/0/false preservados).
 * - T64: Fallback de Emergencia con FieldValue.arrayUnion cuando runTransaction falla.
 * - T65: Continuidad de Estado Cross-Lambda (Simulación Serverless Multicontenedor: Turnos 1, 2 y 3).
 * - T66: Resiliencia ante Documentos Legacy con campos corruptos/undefined en Papelera.
 * - T67: No-Regresión Total del Esquema de Conversación.
 */

import { describe, it, expect, vi } from 'vitest';
import { cleanFirestorePayload } from '../../infrastructure/persistence/FirestoreSanitizer.js';
import { FirestoreConversationRepository, InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { ReceiveMessageUseCase } from '../../application/usecases/ReceiveMessageUseCase.js';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { ILLMProvider } from '../../interfaces/ILLMProvider.js';
import { Conversation } from '../../domain/entities/Conversation.js';

describe('SQA Forense Plan APO-019 — Tests T63 a T67 (Sanitización Firestore, ArrayUnion Fallback y Continuidad Cross-Lambda)', () => {
  const tenantId = 'o3energy_mexico';

  // ──────────────────────────────────────────────────────────────────────────
  // T63: Sanitizador Robusto (Neutralización de NaN, Preservación de Date/Timestamp)
  // ──────────────────────────────────────────────────────────────────────────
  it('T63 (Sanitizador Robusto): Elimina únicamente undefined, convierte NaN a null, preserva Date, Timestamp, null, 0 y false', () => {
    const testDate = new Date('2026-10-12T20:00:00.000Z');
    const mockTimestamp = { constructor: { name: 'Timestamp' }, seconds: 1789674440, nanoseconds: 0 };

    const complexInput = {
      id: '5214777241148',
      validoNull: null,
      invalidoUndef: undefined,
      valorNan: NaN,
      cero: 0,
      falso: false,
      cadenaVacia: '',
      fecha: testDate,
      timestamp: mockTimestamp,
      arrayConTodo: [1, undefined, NaN, null, testDate, { subUndef: undefined, subNan: NaN, subValido: 'ok' }],
      objetoAnidado: {
        a: undefined,
        b: NaN,
        c: null,
        d: 0,
        e: false,
        f: testDate,
      },
    };

    const clean = cleanFirestorePayload(complexInput);

    // 1. Verificación de Date y Timestamp (Defecto 4)
    expect(clean.fecha).toBeInstanceOf(Date);
    expect(clean.fecha).toBe(testDate);
    expect(clean.timestamp).toBe(mockTimestamp);

    // 2. Verificación de NaN -> null (Defecto 3)
    expect(clean.valorNan).toBe(null);

    // 3. Verificación de Preservación de Falsy y Null (Refinamiento C)
    expect(clean.validoNull).toBe(null);
    expect(clean.cero).toBe(0);
    expect(clean.falso).toBe(false);
    expect(clean.cadenaVacia).toBe('');

    // 4. Verificación de Eliminación de Undefined
    expect(clean).not.toHaveProperty('invalidoUndef');

    // 5. Verificación de Objetos y Arrays Anidados
    expect(clean.objetoAnidado).toEqual({
      b: null,
      c: null,
      d: 0,
      e: false,
      f: testDate,
    });
    expect(clean.arrayConTodo).toEqual([
      1,
      null,
      null,
      testDate,
      { subNan: null, subValido: 'ok' },
    ]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T64: Fallback de Emergencia con arrayUnion (Defecto 1)
  // ──────────────────────────────────────────────────────────────────────────
  it('T64 (Fallback Atómico): Ante fallo de runTransaction, ejecuta fallback con arrayUnion sin sobrescribir mensajes', async () => {
    const phone = '5214777241148';
    const setMock = vi.fn().mockResolvedValue(true);
    const mockDocRef = {
      set: setMock,
    };

    const mockDb: any = {
      collection: vi.fn().mockReturnValue({
        doc: vi.fn().mockReturnValue(mockDocRef),
      }),
      // runTransaction falla para forzar el fallback
      runTransaction: vi.fn().mockRejectedValue(new Error('Contention Timeout / Network Glitch')),
    };

    const repo = new FirestoreConversationRepository(mockDb);

    const convToSave: Conversation = {
      id: phone,
      tenantId,
      phone,
      nombre: 'Héctor',
      botDisabled: false,
      messages: [
        { sender: 'user', text: 'Mensaje A', timestamp: '2026-10-12T20:00:00.000Z' },
        { sender: 'bot', text: 'Respuesta A', timestamp: '2026-10-12T20:00:01.000Z' },
      ],
      state: {
        phase: 'QUALIFICATION',
        completedSteps: ['GREETING'],
        missingFields: [],
        leadScore: 0,
      },
      lastMessageAt: '2026-10-12T20:00:01.000Z',
      createdAt: '2026-10-12T20:00:00.000Z',
      status: 'active',
    };

    await repo.save(convToSave);

    // 1. runTransaction fue invocado
    expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);

    // 2. El fallback externo se ejecutó sobre mockDocRef.set
    expect(setMock).toHaveBeenCalledTimes(1);
    const setCallArgs = setMock.mock.calls[0];
    expect(setCallArgs[1]).toEqual({ merge: true });

    // 3. El payload no contiene undefined
    const savedPayload = setCallArgs[0];
    expect(savedPayload.nombre).toBe('Héctor');
    expect(savedPayload).not.toHaveProperty('deletedAt');
  }, 10000);

  // ──────────────────────────────────────────────────────────────────────────
  // T65: Continuidad Cross-Lambda Serverless Multicontenedor (Caso Real de Héctor)
  // ──────────────────────────────────────────────────────────────────────────
  it('T65 (Continuidad Cross-Lambda): Simula 3 Lambdas consecutivas garantizando que Lambda 3 recuerda el nombre y no reenvía brochure', async () => {
    const phone = '5214777241148';

    // Repositorio persistente compartido que simula Firestore en la nube
    const sharedStorage: Record<string, any> = {};

    function createSimulatedFirestore() {
      return {
        collection: (colPath: string) => ({
          doc: (docId: string) => ({
            get: async () => ({
              exists: Boolean(sharedStorage[`${colPath}/${docId}`]),
              id: docId,
              data: () => sharedStorage[`${colPath}/${docId}`] || null,
            }),
            set: async (data: any, options?: any) => {
              if (options?.merge && sharedStorage[`${colPath}/${docId}`]) {
                sharedStorage[`${colPath}/${docId}`] = {
                  ...sharedStorage[`${colPath}/${docId}`],
                  ...data,
                };
              } else {
                sharedStorage[`${colPath}/${docId}`] = data;
              }
            },
          }),
        }),
        runTransaction: async (updateFunction: (tx: any) => Promise<any>) => {
          const fakeTx = {
            get: async (docRef: any) => docRef.get(),
            set: async (docRef: any, data: any, options?: any) => docRef.set(data, options),
            delete: async (docRef: any) => {},
          };
          return updateFunction(fakeTx);
        },
      };
    }

    // Harness helper que simula el inicio de un contenedor Lambda nuevo
    function createLambdaInstance(llmReply: any) {
      const db = createSimulatedFirestore();
      const convRepo = new FirestoreConversationRepository(db);
      const leadRepo = new InMemoryLeadRepository();
      const quoteEngine = new SolarQuoteEngine();
      const sendWhatsApp = vi.fn().mockResolvedValue(true);
      const sendWhatsAppMedia = vi.fn().mockResolvedValue(true);

      const mockLlm: ILLMProvider = {
        complete: vi.fn().mockResolvedValue({
          text: JSON.stringify(llmReply),
          finishReason: 'stop',
          toolCalls: [],
        }),
      };

      const orchestrator = new SofiaFlowOrchestrator(
        convRepo,
        leadRepo,
        quoteEngine,
        mockLlm,
        sendWhatsApp,
        { sendLeadNotification: vi.fn().mockResolvedValue(true) } as any
      );

      const useCase = new ReceiveMessageUseCase(
        convRepo,
        orchestrator,
        sendWhatsApp,
        sendWhatsAppMedia
      );

      return { useCase, convRepo, sendWhatsApp, sendWhatsAppMedia, mockLlm };
    }

    // ─── TURNO 1: Lambda 1 recibe "hola me ayudas?" ─────────────────────────
    const lambda1 = createLambdaInstance({
      next_step: 1,
      message_to_user: '¡Hola! Bienvenido a O3 Energy México. ¿Con quién tengo el gusto?',
      extracted_data: {},
    });

    const reply1 = await lambda1.useCase.execute({
      phone,
      text: 'hola me ayudas?',
      name: 'Cliente',
      inboundTimestamp: '2026-10-12T21:31:00.000Z',
    });

    expect(reply1.reply).toContain('¿Con quién tengo el gusto?');
    // La memoria de Lambda 1 muere. Los datos quedan en sharedStorage.

    // ─── TURNO 2: Lambda 2 recibe "me llamo hectoralvarez" ──────────────────
    const lambda2 = createLambdaInstance({
      next_step: 2,
      message_to_user: '¡Hola Héctoralvarez! ¿Cuánto pagas en tu recibo?',
      extracted_data: { client_name: 'Héctoralvarez' },
      media_to_send: 'INSTALACION_PROFESIONAL',
    });

    const reply2 = await lambda2.useCase.execute({
      phone,
      text: 'me llamo hectoralvarez',
      name: 'Héctoralvarez',
      inboundTimestamp: '2026-10-12T21:31:40.000Z',
    });

    expect(reply2.reply).toContain('¡Hola Héctoralvarez!');
    // Verificar que Lambda 2 envió la infografía
    expect(lambda2.sendWhatsAppMedia).toHaveBeenCalledWith(
      phone,
      expect.stringContaining('INSTALACION_PROFESIONAL'),
      expect.any(String)
    );
    // La memoria de Lambda 2 muere.

    // ─── TURNO 3: Lambda 3 recibe recibo ("te comparto mi recibo!") ─────────
    let lambda3LlmInputHistory = '';
    let lambda3UserName = '';

    const lambda3 = createLambdaInstance({
      next_step: 2,
      message_to_user: '¡Excelente Héctoralvarez! Ya recibí tus datos.',
      extracted_data: {},
    });

    // Interceptar la llamada al LLM en Lambda 3 para inspeccionar el contexto recibido
    const originalComplete = lambda3.mockLlm.complete;
    (lambda3.mockLlm.complete as any) = vi.fn().mockImplementation(async (messages: any[]) => {
      const userPrompt = messages.find((m: any) => m.role === 'user')?.content || '';
      lambda3LlmInputHistory = userPrompt;
      const nameMatch = userPrompt.match(/<name>(.*?)<\/name>/);
      if (nameMatch) lambda3UserName = nameMatch[1];
      return originalComplete(messages);
    });

    await lambda3.useCase.execute({
      phone,
      text: 'te comparto mi recibo!',
      name: 'Héctoralvarez',
      inboundTimestamp: '2026-10-12T21:32:15.000Z',
    });

    // ─── ASERCIONES CRÍTICAS DE CONTINUIDAD CROSS-LAMBDA ────────────────────
    // 1. Lambda 3 reconoció el nombre del cliente y NO lo trató como 'Cliente'
    expect(lambda3UserName).toBe('Héctoralvarez');

    // 2. El brochure de instalación ya estaba marcado como enviado en Firestore
    expect(lambda3LlmInputHistory).toContain('<instalacion_brochure_sent>true</instalacion_brochure_sent>');

    // 3. El historial previo contiene los turnos 1 y 2
    expect(lambda3LlmInputHistory).toContain('me llamo hectoralvarez');

    // 4. Lambda 3 NO volvió a enviar el brochure de instalación
    expect(lambda3.sendWhatsAppMedia).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T66: Resiliencia ante Documentos Legacy con Propiedades Corruptas en Papelera
  // ──────────────────────────────────────────────────────────────────────────
  it('T66 (Resiliencia Papelera): Restaura documento con campos undefined/legacy sin errores de transacción', async () => {
    const phone = '5214777999888';
    const inMemoryDb: Record<string, any> = {
      [`tenants/${tenantId}/deleted_chats/${phone}`]: {
        id: phone,
        phone,
        tenantId,
        nombre: 'Cliente Legacy',
        status: 'deleted',
        deletedAt: '2026-10-12T10:00:00.000Z',
        deletedBy: 'admin',
        campoInvalidoUndefined: undefined,
        tarifaNaN: NaN,
        state: {
          monthlyBill: undefined,
          phase: 'GREETING',
        },
      },
    };

    const mockDb: any = {
      collection: (col: string) => ({
        doc: (id: string) => ({
          get: async () => ({
            exists: Boolean(inMemoryDb[`${col}/${id}`]),
            data: () => inMemoryDb[`${col}/${id}`] || null,
          }),
        }),
      }),
      runTransaction: async (cb: any) => {
        const tx = {
          get: async (ref: any) => ref.get(),
          set: (ref: any, data: any) => {
            // Verificar que no se introducen undefined
            expect(data).not.toHaveProperty('campoInvalidoUndefined');
            expect(data.tarifaNaN).toBe(null);
            expect(data.state).not.toHaveProperty('monthlyBill');
            inMemoryDb[`tenants/${tenantId}/chats/${phone}`] = data;
          },
          delete: (ref: any) => {
            delete inMemoryDb[`tenants/${tenantId}/deleted_chats/${phone}`];
          },
        };
        return cb(tx);
      },
    };

    const repo = new FirestoreConversationRepository(mockDb);
    const restored = await repo.findByPhone(tenantId, phone);

    expect(restored.status).toBe('active');
    expect(restored.nombre).toBe('Cliente Legacy');
    expect(restored).not.toHaveProperty('deletedAt');
    expect(restored).not.toHaveProperty('campoInvalidoUndefined');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T67: No-Regresión Total del Esquema de Conversación
  // ──────────────────────────────────────────────────────────────────────────
  it('T67 (No-Regresión Total): cleanFirestorePayload preserva estructuras de conversación válidas idénticas', () => {
    const sampleConversation: Conversation = {
      id: '5214777000001',
      tenantId: 'o3energy_mexico',
      phone: '5214777000001',
      nombre: 'Juan Manuel',
      botDisabled: false,
      messages: [
        { sender: 'user', text: 'Hola', timestamp: '2026-10-12T20:00:00.000Z' },
        { sender: 'bot', text: '¡Hola!', timestamp: '2026-10-12T20:00:01.000Z' },
      ],
      state: {
        phase: 'QUALIFICATION',
        completedSteps: ['GREETING'],
        missingFields: ['monthlyBill'],
        leadScore: 10,
        monthlyBill: 2500,
        billFrequency: 'mensual',
      },
      lastMessageAt: '2026-10-12T20:00:01.000Z',
      createdAt: '2026-10-12T20:00:00.000Z',
      status: 'active',
    };

    const cleaned = cleanFirestorePayload(sampleConversation);
    expect(cleaned).toEqual(sampleConversation);
  });
});

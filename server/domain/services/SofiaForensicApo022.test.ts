/**
 * SofiaForensicApo022.test.ts
 * Batería SQA Forense de Validación Arquitectónica APO-022.
 * Auditoría: Qwen Senior Forensic Auditor & Héctor Álvarez.
 * Mandatos:
 * - T74: Concurrencia Multi-Webhook (Anverso + Reverso simultáneos -> 1 sola respuesta a WhatsApp y cero duplicación).
 * - T75: State-Aware Media Fallback (INFRASTRUCTURE_ERROR en archivo secundario con monthlyBill existente -> Silencio activo, cero interrupción a TECHNICAL_SURVEY).
 * - T76: Cortafuegos WAMID (Deduplicación estricta de reintentos Meta Cloud API -> sendWhatsApp llamado exactamente 1 sola vez).
 * - T77: Erradicación Total de Texto Hardcoded y Timers Arbitrarios (Reverso complementario absorbido en silencio sin texto "Ya contamos con tu propuesta").
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReceiveMessageUseCase } from '../../application/usecases/ReceiveMessageUseCase.js';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { WhatsAppMediaService } from '../../infrastructure/media/WhatsAppMediaService.js';
import { CfeReceiptExtractorService } from '../services/CfeReceiptExtractorService.js';
import { WamidIdempotencyService } from '../../infrastructure/services/WamidIdempotencyService.js';

describe('SQA Forense Plan APO-022 — Tests T74 a T77 (Cortafuegos WAMID, State-Aware Fallbacks y Erradicación de Texto Hardcoded)', () => {
  const tenantId = 'o3energy_mexico';

  function createTestHarness(options?: {
    customFetch?: typeof fetch;
    llmResponses?: Array<{ content: string }>;
  }) {
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();
    const sendWhatsApp = vi.fn().mockResolvedValue(true);
    const sendWhatsAppMedia = vi.fn().mockResolvedValue(true);

    const mockLlm = {
      complete: vi.fn().mockImplementation(async () => {
        if (options?.llmResponses && options.llmResponses.length > 0) {
          const resp = options.llmResponses.shift()!;
          return {
            text: JSON.stringify({
              next_step: 3,
              message_to_user: resp.content,
              extracted_data: {},
            }),
            finishReason: 'stop',
          };
        }
        return {
          text: JSON.stringify({
            next_step: 3,
            message_to_user: '¡Gracias, Héctor! He recibido el monto de tu recibo. ¿Qué tipo de techo tienes?',
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

    const mockFetch =
      options?.customFetch ||
      (vi.fn().mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('lookaside')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            arrayBuffer: async () => Buffer.from('MOCK_JPEG_IMAGE_DATA'),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            url: 'https://lookaside.fbsbx.com/test-media',
            mime_type: 'image/jpeg',
            file_size: 200000,
            id: 'test-media-id',
          }),
        });
      }) as any);

    const mediaService = new WhatsAppMediaService(mockFetch);

    const extractorService = new CfeReceiptExtractorService();

    const useCase = new ReceiveMessageUseCase(
      convRepo,
      orchestrator,
      sendWhatsApp,
      sendWhatsAppMedia,
      mediaService,
      extractorService
    );

    const idempotencyService = new WamidIdempotencyService();

    return {
      convRepo,
      leadRepo,
      quoteEngine,
      sendWhatsApp,
      sendWhatsAppMedia,
      orchestrator,
      mediaService,
      extractorService,
      useCase,
      mockLlm,
      idempotencyService,
    };
  }

  // ─── T74: CONCURRENCIA MULTI-WEBHOOK (ANVERSO + REVERSO EN PARALELO) ─────────
  it('T74: Concurrencia Multi-Webhook (Anverso + Reverso concurrentes) -> 1 sola llamada a sendWhatsApp y cero duplicación', async () => {
    const phone = '5214777022074';
    const harness = createTestHarness();

    // Mock extractor para diferenciar anverso de reverso
    harness.extractorService.analyzeReceipt = vi.fn().mockImplementation(async (buffer, mime, filename) => {
      if (filename?.includes('page-0002') || filename?.includes('reverso')) {
        return {
          status: 'REVERSE_PAGE' as const,
          documentType: 'CFE_REVERSO' as const,
          diagnostico: 'Historial de consumo bimestral',
        };
      }
      return {
        status: 'SUCCESS' as const,
        documentType: 'CFE_ANVERSO' as const,
        data: {
          tipoDocumento: 'CFE_ANVERSO' as const,
          montoTotal: 148228,
          periodo: 'mensual' as const,
          tarifa: 'GDMTH',
          confianza: 'alta' as const,
        },
      };
    });

    // Ejecución simultánea simulando dos webhooks paralelos de Meta
    const [resAnverso, resReverso] = await Promise.all([
      harness.useCase.execute({
        phone,
        tenantId,
        mediaId: 'meta-media-anverso-74',
        mediaType: 'image',
        mediaFilename: 'page-0001.jpg',
      }),
      harness.useCase.execute({
        phone,
        tenantId,
        mediaId: 'meta-media-reverso-74',
        mediaType: 'image',
        mediaFilename: 'page-0002.jpg',
      }),
    ]);

    // 1. sendWhatsApp es llamado exactamente 1 sola vez (la respuesta al anverso)
    expect(harness.sendWhatsApp).toHaveBeenCalledTimes(1);

    // 2. El mensaje enviado es la respuesta de calificación/techo, no un fallback duplicado
    expect(resAnverso.reply).toContain('¿Qué tipo de techo tienes?');
    expect(resReverso.reply).toBe(''); // Reverso fue asimilado en silencio

    // 3. El estado de la conversación preserva el monto extraído
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(conv.state.monthlyBill).toBe(148228);
  });

  // ─── T75: STATE-AWARE MEDIA FALLBACK (INFRASTRUCTURE_ERROR EN ARCHIVO SECUNDARIO)
  it('T75: State-Aware Media Fallback (INFRASTRUCTURE_ERROR en archivo secundario con bill ya extraído) -> Silencio activo, cero interrupción a TECHNICAL_SURVEY', async () => {
    const phone = '5214777022075';
    const harness = createTestHarness();

    // 1. Inicializar la conversación con el monto ya extraído previamente y en fase TECHNICAL_SURVEY
    const existingConv = await harness.convRepo.findByPhone(tenantId, phone);
    existingConv.nombre = 'Héctor Álvarez';
    existingConv.state.monthlyBill = 148228;
    existingConv.state.billFrequency = 'mensual';
    existingConv.state.roofType = 'concreto';
    existingConv.state.phase = 'TECHNICAL_SURVEY';
    existingConv.state.completedSteps = ['GREETING', 'QUALIFICATION', 'NAME_CONFIRMED', 'BILL_NORMALIZED', 'ROOF_CONFIRMED'];
    await harness.convRepo.save(existingConv);

    // 2. Mockear fallo de infraestructura (429 Rate-Limit de Gemini Vision) en el segundo archivo
    harness.extractorService.analyzeReceipt = vi.fn().mockResolvedValue({
      status: 'INFRASTRUCTURE_ERROR' as const,
      errorType: 'RATE_LIMITED' as const,
      message: 'Resource has been exhausted (e.g. check quota)',
    });

    // 3. Procesar archivo secundario con error de infraestructura
    const result = await harness.useCase.execute({
      phone,
      tenantId,
      mediaId: 'meta-media-secondary-err-75',
      mediaType: 'image',
      mediaFilename: 'page-0002.jpg',
    });

    // Afirmación A: El resultado de respuesta hacia el usuario está vacío (Silencio Activo)
    expect(result.reply).toBe('');

    // Afirmación B: NO contiene la palabra "intermitencia" ni "¿me podrías confirmar la cantidad exacta?"
    expect(result.reply).not.toContain('intermitencia');
    expect(result.reply).not.toContain('monto');
    expect(result.reply).not.toContain('cantidad exacta');

    // Afirmación C: sendWhatsApp NO fue llamado (cero spam al usuario)
    expect(harness.sendWhatsApp).not.toHaveBeenCalled();

    // Afirmación D: El estado de la cotización y la fase en Firestore permanecen 100% intactos
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(conv.state.monthlyBill).toBe(148228);
    expect(conv.state.roofType).toBe('concreto');
    expect(conv.state.phase).toBe('TECHNICAL_SURVEY');

    // Afirmación E: Se preservó la nota técnica interna en el array de mensajes para auditoría del CRM
    const userNotes = conv.messages.filter((m) => m.sender === 'user');
    expect(userNotes.some((m) => m.text.includes('Intermitencia técnica al procesar archivo secundario'))).toBe(true);
  });

  // ─── T76: CORTAFUEGOS WAMID (DEDUPLICACIÓN DE REINTENTOS DE META CLOUD API) ─────
  it('T76: Cortafuegos WAMID (Doble llamada con el mismo WAMID) -> La segunda llamada es rechazada como duplicada y sendWhatsApp se llama 1 sola vez', async () => {
    const phone = '5214777022076';
    const testWamid = 'wamid.HBgLMjE0Nzc3MjQxMTQ4FQIAEhggM0E0NzgwNUM2N0VDMDhFMzk4MzY1RDc2';
    const harness = createTestHarness();

    // Simular webhook handler con el WAMID Guard implementado en v2Router.ts
    async function simulateWebhookInbound(wamid: string, text: string) {
      // 1. Verificación del Cortafuegos WAMID
      const isFresh = await harness.idempotencyService.checkAndLock(tenantId, wamid);
      if (!isFresh) {
        return { status: 200, body: { status: 'duplicate_ignored', wamid } };
      }

      // 2. Si es fresco, ejecuta el useCase
      const execResult = await harness.useCase.execute({
        phone,
        tenantId,
        text,
      });

      return { status: 200, body: { status: 'received', reply: execResult.reply } };
    }

    // Primer intento entrante de Meta
    const firstCall = await simulateWebhookInbound(testWamid, 'Hola, me interesa una cotización solar');
    expect(firstCall.status).toBe(200);
    expect(firstCall.body.status).toBe('received');
    expect(harness.sendWhatsApp).toHaveBeenCalledTimes(1);

    // Segundo intento (Retry automático de Meta Cloud API con el MISMO WAMID tras timeout)
    const secondCall = await simulateWebhookInbound(testWamid, 'Hola, me interesa una cotización solar');
    expect(secondCall.status).toBe(200);
    expect(secondCall.body.status).toBe('duplicate_ignored');
    expect(secondCall.body.wamid).toBe(testWamid);

    // Afirmación Crítica: sendWhatsApp NO se volvió a llamar, se mantuvo en 1 sola invocación
    expect(harness.sendWhatsApp).toHaveBeenCalledTimes(1);
  });

  // ─── T77: ERRADICACIÓN TOTAL DE TEXTO HARDCODED Y TIMERS ARBITRARIOS ───────────
  it('T77: Erradicación Total de Texto Hardcoded (Reverso recibido durante TECHNICAL_SURVEY) -> No afirma "Ya contamos con tu propuesta" y preserva flujo', async () => {
    const phone = '5214777022077';
    const harness = createTestHarness();

    // 1. Configurar conversación en fase TECHNICAL_SURVEY con monthlyBill ya extraído
    const existingConv = await harness.convRepo.findByPhone(tenantId, phone);
    existingConv.nombre = 'Héctor Álvarez';
    existingConv.state.monthlyBill = 148228;
    existingConv.state.phase = 'TECHNICAL_SURVEY';
    // lastBillExtractedAt se fija hace 10 minutos (600,000 ms), muy superior al viejo timer arbitrario de 30s
    existingConv.state.lastBillExtractedAt = new Date(Date.now() - 600000).toISOString();
    await harness.convRepo.save(existingConv);

    // 2. Mockear reverso complementario exitoso
    harness.extractorService.analyzeReceipt = vi.fn().mockResolvedValue({
      status: 'REVERSE_PAGE' as const,
      documentType: 'CFE_REVERSO' as const,
      diagnostico: 'Historial de consumo complementario',
    });

    // 3. Procesar reverso complementario
    const result = await harness.useCase.execute({
      phone,
      tenantId,
      mediaId: 'meta-media-reverso-77',
      mediaType: 'image',
      mediaFilename: 'page-0002.jpg',
    });

    // Afirmación A: El resultado es silencioso (cero interrupción)
    expect(result.reply).toBe('');

    // Afirmación B: NUNCA afirma la frase quemada errónea
    expect(result.reply).not.toContain('Ya contamos con tu propuesta');
    expect(result.reply).not.toContain('opciones de financiamiento');

    // Afirmación C: sendWhatsApp no fue llamado con spam
    expect(harness.sendWhatsApp).not.toHaveBeenCalled();

    // Afirmación D: La fase permanece en TECHNICAL_SURVEY
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(conv.state.phase).toBe('TECHNICAL_SURVEY');
    expect(conv.state.monthlyBill).toBe(148228);
  });
});

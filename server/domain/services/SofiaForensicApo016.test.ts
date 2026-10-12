/**
 * SofiaForensicApo016.test.ts
 * Suite de Pruebas de Calidad de Software (SQA) - Plan de Mitigación Forense APO-016.
 * Auditoría: Qwen Senior Forensic Auditor & Héctor (Mandatos T48 a T52).
 * 
 * Cobertura de Escenarios Concurrencia Serverless y Multi-Webhook (WhatsApp Desktop):
 * - T48 (Concurrencia Realista Simulada): Promise.all de Anverso + Reverso en paralelo -> 1 sola llamada a sendWhatsApp con cotización.
 * - T49 (Caso Borde: Reverso Primero): Reverso llega antes sin bill -> sendWhatsApp NO es llamado, reversePageReceived = true. Luego llega anverso y la respuesta menciona "ambas páginas".
 * - T50 (Reverso Complementario Posterior): monthlyBill ya existe -> respuesta de agradecimiento contextual sin pedir anverso.
 * - T51 (Reverso Huérfano Auténtico): Reverso solo -> silent buffer -> interacción posterior de texto -> solicita empáticamente el anverso.
 * - T52 (Regresión Total y Atomicidad): Persistencia atómica anti-lost-updates en escrituras concurrentes.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReceiveMessageUseCase, MediaAttachmentItem } from '../../application/usecases/ReceiveMessageUseCase.js';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { ILLMProvider } from '../../interfaces/ILLMProvider.js';
import { WhatsAppMediaService } from '../../infrastructure/media/WhatsAppMediaService.js';
import { CfeReceiptExtractorService } from './CfeReceiptExtractorService.js';

describe('SQA Forense Plan APO-016 — Tests T48 a T52 (Concurrencia Multi-Webhook y Blindaje de Estado Serverless)', () => {
  const tenantId = 'o3energy_mexico';

  function createUsecaseHarness(deps?: {
    customFetch?: typeof fetch;
    extractorDeps?: {
      pdfParserFn?: (buffer: Buffer) => Promise<string>;
      geminiVisionFn?: (buffer: Buffer, mimeType: string) => Promise<any>;
      customFetch?: typeof fetch;
    };
    llmResponses?: any[];
  }) {
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();
    const sendWhatsApp = vi.fn().mockResolvedValue(true);
    const sendWhatsAppMedia = vi.fn().mockResolvedValue(true);

    const mockLlm: ILLMProvider = {
      complete: vi.fn(),
    };

    if (deps?.llmResponses && deps.llmResponses.length > 0) {
      deps.llmResponses.forEach((resp) => {
        (mockLlm.complete as any).mockResolvedValueOnce({
          text: typeof resp === 'string' ? resp : JSON.stringify(resp),
          finishReason: 'stop',
        });
      });
    } else {
      (mockLlm.complete as any).mockResolvedValue({
        text: JSON.stringify({
          next_step: 3,
          message_to_user: '¡Excelente! He recibido tu recibo de CFE. Para continuar con tu cotización, ¿qué tipo de techo tienes?',
          extracted_data: {},
        }),
        finishReason: 'stop',
      });
    }

    const orchestrator = new SofiaFlowOrchestrator(
      convRepo,
      leadRepo,
      quoteEngine,
      mockLlm,
      sendWhatsApp,
      { sendLeadEmailNotification: vi.fn().mockResolvedValue(true) } as any
    );

    const mediaService = new WhatsAppMediaService(deps?.customFetch);
    const extractorService = new CfeReceiptExtractorService(deps?.extractorDeps);

    const useCase = new ReceiveMessageUseCase(
      convRepo,
      orchestrator,
      sendWhatsApp,
      sendWhatsAppMedia,
      mediaService,
      extractorService
    );

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
    };
  }

  // ─── T48: CONCURRENCIA REALISTA SIMULADA (PROMISE.ALL) ──────────────────────
  it('T48 (Concurrencia Realista Simulada): Promise.all de Anverso y Reverso concurrentes -> Exactamente 1 respuesta a WhatsApp con cotización y 0 mensajes contradictorios', async () => {
    const phone = '5214777016048';

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('meta-anverso-id')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            url: 'https://lookaside.fbsbx.com/anverso-url',
            mime_type: 'image/jpeg',
            file_size: 250000,
            id: 'meta-anverso-id',
          }),
        });
      }
      if (url.includes('meta-reverso-id')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            url: 'https://lookaside.fbsbx.com/reverso-url',
            mime_type: 'image/jpeg',
            file_size: 200000,
            id: 'meta-reverso-id',
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => Buffer.from('MOCK_JPEG_IMAGE_DATA'),
      });
    });

    const mockVisionFn = vi.fn().mockImplementation(async (buffer: Buffer) => {
      // Simular latencias asíncronas realistas
      await new Promise((res) => setTimeout(res, 20));
      return {
        tipoDocumento: 'CFE_ANVERSO',
        montoTotal: 148228,
        periodo: 'bimestral',
        tarifa: 'GDMTH',
        confianza: 'alta',
      };
    });

    const mockVisionReversoFn = vi.fn().mockImplementation(async (buffer: Buffer) => {
      await new Promise((res) => setTimeout(res, 10));
      return {
        tipoDocumento: 'CFE_REVERSO',
        diagnostico: 'Historial de consumo bimestral en kWh',
        confianza: 'alta',
      };
    });

    // Harness con extractor adaptable
    const harness = createUsecaseHarness({
      customFetch: mockFetch as any,
      extractorDeps: {
        geminiVisionFn: async (buf, mime) => {
          // Si el mediaId o llamada corresponde a anverso
          if ((harness.extractorService as any)._currentMedia === 'meta-reverso-id') {
            return mockVisionReversoFn(buf);
          }
          return mockVisionFn(buf);
        },
      },
      llmResponses: [
        {
          next_step: 3,
          message_to_user: '¡Gracias, Héctor! He recibido tu recibo de $148,228 MXN. ¿Qué tipo de techo tienes?',
          extracted_data: { bill_amount: 148228, bill_frequency: 'bimestral' },
        },
      ],
    });

    // Sobrescribir analyzeReceipt para dirigir anverso vs reverso
    const originalAnalyze = harness.extractorService.analyzeReceipt.bind(harness.extractorService);
    harness.extractorService.analyzeReceipt = vi.fn().mockImplementation(async (buf, mime, filename) => {
      if (filename?.includes('reverso') || filename?.includes('page-0002')) {
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
          periodo: 'bimestral' as const,
          tarifa: 'GDMTH',
          confianza: 'alta' as const,
        },
      };
    });

    // Disparo concurrente con Promise.all simulando WhatsApp Desktop
    const [resAnverso, resReverso] = await Promise.all([
      harness.useCase.execute({
        phone,
        tenantId,
        mediaId: 'meta-anverso-id',
        mediaType: 'image',
        mediaFilename: 'page-0001.jpg',
      }),
      harness.useCase.execute({
        phone,
        tenantId,
        mediaId: 'meta-reverso-id',
        mediaType: 'image',
        mediaFilename: 'page-0002.jpg',
      }),
    ]);

    // 1. Exactamente UNA sola llamada a sendWhatsApp
    expect(harness.sendWhatsApp).toHaveBeenCalledTimes(1);

    // 2. El mensaje enviado contiene la cotización/análisis del anverso
    expect(harness.sendWhatsApp).toHaveBeenCalledWith(
      phone,
      expect.stringContaining('$148,228')
    );

    // 3. Cero mensajes de fallback pidiendo el anverso
    expect(harness.sendWhatsApp).not.toHaveBeenCalledWith(
      phone,
      expect.stringContaining('¿podrías compartirme también el anverso')
    );

    // 4. En el estado de Firestore / conversación se registraron ambos documentos sin sobrescritura
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(conv.state.monthlyBill).toBe(74114); // 148,228 bimestral normalizado a mensual
    expect(conv.state.bimestralBill).toBe(148228);

    const userMessages = conv.messages.filter((m) => m.sender === 'user');
    expect(userMessages.length).toBeGreaterThanOrEqual(1);
    const combinedUserText = userMessages.map((m) => m.text).join(' ');
    expect(combinedUserText).toContain('148,228');
  });

  // ─── T49: CASO BORDE "REVERSO PRIMERO" ──────────────────────────────────────
  it('T49 (Caso Borde: Reverso Primero): Reverso llega antes sin bill -> sendWhatsApp NO es llamado; al llegar anverso la respuesta menciona "ambas páginas"', async () => {
    const phone = '5214777016049';

    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          url: 'https://lookaside.fbsbx.com/test-media',
          mime_type: 'image/jpeg',
          file_size: 200000,
          id: 'test-media-id',
        }),
        arrayBuffer: async () => Buffer.from('MOCK_IMAGE'),
      })
    );

    const harness = createUsecaseHarness({
      customFetch: mockFetch as any,
      llmResponses: [
        {
          next_step: 3,
          message_to_user: '¡Excelente, Héctor! Con tu consumo mensual el sistema ideal es de 12 paneles.',
          extracted_data: { bill_amount: 148228, bill_frequency: 'bimestral' },
        },
      ],
    });

    harness.extractorService.analyzeReceipt = vi.fn().mockImplementation(async (buf, mime, filename) => {
      if (filename?.includes('reverso') || filename?.includes('page-0002')) {
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
          periodo: 'bimestral' as const,
          tarifa: 'GDMTH',
          confianza: 'alta' as const,
        },
      };
    });

    // 1. Disparar primero el UseCase con Reverso (sin bill previo)
    const resultReverso = await harness.useCase.execute({
      phone,
      tenantId,
      mediaId: 'media-reverso-first',
      mediaType: 'image',
      mediaFilename: 'page-0002.jpg',
    });

    // Afirmación: sendWhatsApp NO es llamado en esta primera entrega
    expect(harness.sendWhatsApp).not.toHaveBeenCalled();
    expect(resultReverso.reply).toBe('');

    // Afirmación: reversePageReceived se establece en true en el repositorio
    let conv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(conv.state.reversePageReceived).toBe(true);
    expect(conv.state.monthlyBill).toBeUndefined();

    // 2. Disparar ahora el UseCase con Anverso
    const resultAnverso = await harness.useCase.execute({
      phone,
      tenantId,
      mediaId: 'media-anverso-second',
      mediaType: 'image',
      mediaFilename: 'page-0001.jpg',
    });

    // Afirmación: sendWhatsApp ahora SÍ es llamado una vez con la cotización
    expect(harness.sendWhatsApp).toHaveBeenCalledTimes(1);

    // Afirmación: La respuesta final menciona que se procesaron "ambas páginas"
    expect(resultAnverso.reply).toMatch(/ambas p[áa]ginas/i);

    // Afirmación: El flag reversePageReceived se limpia tras la consolidación exitosa
    conv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(conv.state.reversePageReceived).toBe(false);
    expect(conv.state.monthlyBill).toBe(74114);
  });

  // ─── T50: REVERSO COMPLEMENTARIO POSTERIOR ──────────────────────────────────
  it('T50 (Reverso Complementario Posterior): monthlyBill ya existe -> Sofía agradece contextualmente sin pedir anverso de nuevo', async () => {
    const phone = '5214777016050';

    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          url: 'https://lookaside.fbsbx.com/test-media',
          mime_type: 'image/jpeg',
          file_size: 200000,
          id: 'test-media-id',
        }),
        arrayBuffer: async () => Buffer.from('MOCK_IMAGE'),
      })
    );

    const harness = createUsecaseHarness({
      customFetch: mockFetch as any,
    });

    harness.extractorService.analyzeReceipt = vi.fn().mockResolvedValue({
      status: 'REVERSE_PAGE' as const,
      documentType: 'CFE_REVERSO' as const,
      diagnostico: 'Historial de consumo bimestral',
    });

    // Inicializar conversación con monthlyBill ya establecido previamente (fase TECHNICAL_SURVEY)
    const existingConv = await harness.convRepo.findByPhone(tenantId, phone);
    existingConv.state.monthlyBill = 74114;
    existingConv.state.bimestralBill = 148228;
    existingConv.state.phase = 'TECHNICAL_SURVEY';
    existingConv.state.completedSteps = ['GREETING', 'QUALIFICATION'];
    await harness.convRepo.save(existingConv);

    // Usuario envía reverso como información complementaria tiempo después
    const result = await harness.useCase.execute({
      phone,
      tenantId,
      mediaId: 'media-reverso-complementario',
      mediaType: 'image',
      mediaFilename: 'historial_reverso.jpg',
    });

    // 1. Sofía agradece contextualmente
    expect(result.reply).toContain('Recibí el historial de consumo complementario');
    expect(result.reply).toContain('Ya contamos con tu propuesta');

    // 2. NO solicita el anverso ni el monto de nuevo
    expect(result.reply).not.toContain('¿podrías compartirme también el anverso');
    expect(result.reply).not.toContain('confirmarme tu monto');

    // 3. Enviado por WhatsApp
    expect(harness.sendWhatsApp).toHaveBeenCalledWith(
      phone,
      expect.stringContaining('Recibí el historial de consumo complementario')
    );
  });

  // ─── T51: REVERSO HUÉRFANO AUTÉNTICO ────────────────────────────────────────
  it('T51 (Reverso Huérfano Auténtico): Reverso solo -> buffer silencioso -> mensaje de texto posterior -> solicita empáticamente el anverso', async () => {
    const phone = '5214777016051';

    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          url: 'https://lookaside.fbsbx.com/test-media',
          mime_type: 'image/jpeg',
          file_size: 200000,
          id: 'test-media-id',
        }),
        arrayBuffer: async () => Buffer.from('MOCK_IMAGE'),
      })
    );

    const harness = createUsecaseHarness({
      customFetch: mockFetch as any,
    });

    harness.extractorService.analyzeReceipt = vi.fn().mockResolvedValue({
      status: 'REVERSE_PAGE' as const,
      documentType: 'CFE_REVERSO' as const,
      diagnostico: 'Historial de consumo bimestral',
    });

    // Turno 1: Usuario nuevo envía únicamente el reverso de su recibo
    const turn1Result = await harness.useCase.execute({
      phone,
      tenantId,
      mediaId: 'media-orphan-reverso',
      mediaType: 'image',
      mediaFilename: 'reverso_solo.jpg',
    });

    // Buffering silencioso en turno 1
    expect(turn1Result.reply).toBe('');
    expect(harness.sendWhatsApp).not.toHaveBeenCalled();

    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(conv.state.reversePageReceived).toBe(true);
    expect(conv.state.monthlyBill).toBeUndefined();

    // Turno 2: El usuario envía un mensaje de texto de seguimiento ("¿qué tal? ¿pudiste ver mi recibo?")
    const turn2Result = await harness.useCase.execute({
      phone,
      tenantId,
      text: '¿Qué tal? ¿Pudiste revisar mi recibo?',
    });

    // Ahora Sofía responde empáticamente pidiendo el anverso
    expect(turn2Result.reply).toContain('Recibí el historial de consumo de tu recibo CFE 📄');
    expect(turn2Result.reply).toContain('¿podrías compartirme también el anverso');
    expect(harness.sendWhatsApp).toHaveBeenCalledWith(
      phone,
      expect.stringContaining('Recibí el historial de consumo de tu recibo CFE')
    );
  });

  // ─── T52: REGRESIÓN TOTAL Y ATOMICIDAD ──────────────────────────────────────
  it('T52 (Regresión Total y Atomicidad): Reconciliación atómica en save preserva mensajes y estados concurrentes', async () => {
    const repo = new InMemoryConversationRepository();
    const phone = '5214777016052';

    const convA = await repo.findByPhone(tenantId, phone);
    convA.messages.push({ sender: 'user', text: 'Mensaje A', timestamp: '2026-10-12T12:00:00.000Z' });
    convA.state.completedSteps = ['STEP_1'];
    convA.state.monthlyBill = 15000;

    const convB = await repo.findByPhone(tenantId, phone);
    convB.messages.push({ sender: 'user', text: 'Mensaje B', timestamp: '2026-10-12T12:00:01.000Z' });
    convB.state.completedSteps = ['STEP_2'];

    // Guardado concurrente
    await Promise.all([repo.save(convA), repo.save(convB)]);

    const finalConv = await repo.findByPhone(tenantId, phone);
    // 1. Mensajes concatenados defensivamente sin perder datos
    const texts = finalConv.messages.map((m) => m.text);
    expect(texts).toContain('Mensaje A');
    expect(texts).toContain('Mensaje B');

    // 2. Pasos completados unidos
    expect(finalConv.state.completedSteps).toContain('STEP_1');
    expect(finalConv.state.completedSteps).toContain('STEP_2');

    // 3. Monto preservado
    expect(finalConv.state.monthlyBill).toBe(15000);
  });
});

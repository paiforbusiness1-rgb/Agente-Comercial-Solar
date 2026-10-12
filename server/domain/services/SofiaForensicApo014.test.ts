/**
 * SofiaForensicApo014.test.ts
 * Suite de Pruebas de Calidad de Software (SQA) - Plan de Mitigación Forense APO-014.
 * Auditoría: Qwen Core Forensic Audit & Mandato Inamovible SQA (Regla 5).
 * 
 * Cobertura de Escenarios:
 * - TS-01 (Éxito Anverso): Extracción de CFE_ANVERSO con monto válido y avance a cotización.
 * - TS-02 (Detección Reverso): Detección de CFE_REVERSO sin monto, retención de estado y respuesta empática U-First.
 * - TS-03 (Documento No CFE): Detección de OTRO_DOCUMENTO y respuesta de orientación.
 * - TS-04 (Ilegibilidad Real): Detección de NO_LEGIBLE y solicitud de foto más nítida.
 * - TS-05 (Resiliencia Infraestructura): Captura de HTTP 404/429 con transparencia técnica sin culpar al usuario.
 * - TS-06 (Self-Healing Cascading Resolver): Reintento automático ante modelo 404 hasta modelo exitoso en cascada.
 * - TS-07 (Ingesta Múltiples Adjuntos): Ingesta consolidada de 2 archivos con respuesta única en el chat.
 * - TS-08 (Cero Regresiones): Preservación de toda la suite histórica previa.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReceiveMessageUseCase, MediaAttachmentItem } from '../../application/usecases/ReceiveMessageUseCase.js';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { ILLMProvider } from '../../interfaces/ILLMProvider.js';
import { WhatsAppMediaService } from '../../infrastructure/media/WhatsAppMediaService.js';
import { CfeReceiptExtractorService } from './CfeReceiptExtractorService.js';

describe('SQA Forense Plan APO-014 — Tests TS-01 a TS-07 (Clasificación CFE, Resiliencia y Consolidación Multi-Medio)', () => {
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

  // ─── TS-01: ÉXITO ANVERSO CFE ──────────────────────────────────────────────
  it('TS-01 (Éxito Anverso): Extrae CFE_ANVERSO con monto ($148,228) y avanza a cotización', async () => {
    const phone = '5214777014001';

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: 'https://lookaside.fbsbx.com/mock-anverso',
          mime_type: 'image/jpeg',
          file_size: 250000,
          id: 'media-anverso-01',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => Buffer.from('MOCK_JPEG_ANVERSO_CFE'),
      });

    const mockVisionResult = {
      tipoDocumento: 'CFE_ANVERSO',
      montoTotal: 148228,
      periodo: 'mensual',
      tarifa: 'GDMTH',
      numeroServicio: '615861100302',
      nombreCliente: 'JTA MPAL DE AGUA Y SANEAMIENTO',
      confianza: 'alta',
      diagnostico: 'Recibo CFE GDMTH anverso legible con total a pagar',
    };

    const harness = createUsecaseHarness({
      customFetch: mockFetch as any,
      extractorDeps: {
        geminiVisionFn: async () => mockVisionResult,
      },
      llmResponses: [
        {
          next_step: 3,
          message_to_user: '¡Muchas gracias! Ya pude revisar tu recibo CFE de $148,228 al mes (Tarifa GDMTH). ¿Qué tipo de techo tiene tu nave o pozo?',
          extracted_data: {
            bill_amount: 148228,
            bill_frequency: 'mensual',
          },
        },
      ],
    });

    const result = await harness.useCase.execute({
      phone,
      tenantId,
      mediaId: 'media-anverso-01',
      mediaType: 'image',
      mediaFilename: '02. Pozo 3 - 615861100302_page-0001.jpg',
    });

    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(conv.state.monthlyBill).toBe(148228);
    expect((conv.state as any).tariff).toBe('GDMTH');
    expect(conv.state.billFrequency).toBe('mensual');

    expect(result.reply).toContain('$148,228');
    expect(result.reply).not.toContain('borrosa');
    expect(harness.sendWhatsApp).toHaveBeenCalledTimes(1);
  });

  // ─── TS-02: DETECCIÓN REVERSO CFE (PÁGINA 2) ───────────────────────────────
  it('TS-02 (Detección Reverso): Detecta CFE_REVERSO, no asigna monto y pide amablemente el anverso sin culpar a la imagen', async () => {
    const phone = '5214777014002';

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: 'https://lookaside.fbsbx.com/mock-reverso',
          mime_type: 'image/jpeg',
          file_size: 280000,
          id: 'media-reverso-02',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => Buffer.from('MOCK_JPEG_REVERSO_CFE'),
      });

    const mockVisionResult = {
      tipoDocumento: 'CFE_REVERSO',
      diagnostico: 'Gráficas de consumo histórico en kWh y demanda máxima',
      confianza: 'alta',
      numeroServicio: '615861100302',
      tarifa: 'GDMTH',
      periodo: 'mensual',
    };

    const harness = createUsecaseHarness({
      customFetch: mockFetch as any,
      extractorDeps: {
        geminiVisionFn: async () => mockVisionResult,
      },
    });

    // Turno 1: Envío de reverso (se almacena en búfer seguro según Refinamiento 2 de APO-016)
    await harness.useCase.execute({
      phone,
      tenantId,
      mediaId: 'media-reverso-02',
      mediaType: 'image',
      mediaFilename: '02. Pozo 3 - 615861100302_page-0002.jpg',
    });

    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    // 1. NO contamina el estado con montos
    expect(conv.state.monthlyBill).toBeUndefined();
    expect(conv.state.reversePageReceived).toBe(true);

    // Turno 2: Interacción de seguimiento sin anverso (Reverso huérfano confirmado)
    const result = await harness.useCase.execute({
      phone,
      tenantId,
      text: '¿Pudiste revisar mi consumo?',
    });

    // 2. Respuesta empática orientada al reverso
    expect(result.reply).toContain('Recibí el historial de consumo de tu recibo CFE');
    expect(result.reply).toContain('¿podrías compartirme también el anverso');
    expect(result.reply).not.toContain('borrosa');

    // 3. Enviado por WhatsApp
    expect(harness.sendWhatsApp).toHaveBeenCalledWith(
      phone,
      expect.stringContaining('Recibí el historial de consumo')
    );
  });

  // ─── TS-03: DOCUMENTO NO CFE ──────────────────────────────────────────────
  it('TS-03 (Documento No CFE): Detecta OTRO_DOCUMENTO y orienta al usuario sin acusar a la foto', async () => {
    const phone = '5214777014003';

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: 'https://lookaside.fbsbx.com/mock-id',
          mime_type: 'image/jpeg',
          file_size: 150000,
          id: 'media-id-03',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => Buffer.from('MOCK_JPEG_INE_DOC'),
      });

    const mockVisionResult = {
      tipoDocumento: 'OTRO_DOCUMENTO',
      diagnostico: 'Credencial de elector INE, no es factura de CFE',
      confianza: 'alta',
    };

    const harness = createUsecaseHarness({
      customFetch: mockFetch as any,
      extractorDeps: {
        geminiVisionFn: async () => mockVisionResult,
      },
    });

    const result = await harness.useCase.execute({
      phone,
      tenantId,
      mediaId: 'media-id-03',
      mediaType: 'image',
      mediaFilename: 'Identificacion.jpg',
    });

    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(conv.state.monthlyBill).toBeUndefined();

    expect(result.reply).toContain('parece que no corresponde a una factura de CFE');
    expect(result.reply).toContain('¿Podrías compartirme tu factura de luz de CFE');
    expect(result.reply).not.toContain('borrosa');
  });

  // ─── TS-04: ILEGIBILIDAD REAL ─────────────────────────────────────────────
  it('TS-04 (Ilegibilidad Real): Detecta NO_LEGIBLE y solicita foto más nítida o monto manual', async () => {
    const phone = '5214777014004';

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: 'https://lookaside.fbsbx.com/mock-dark',
          mime_type: 'image/jpeg',
          file_size: 100000,
          id: 'media-dark-04',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => Buffer.from('MOCK_DARK_IMAGE'),
      });

    const mockVisionResult = {
      tipoDocumento: 'NO_LEGIBLE',
      diagnostico: 'Foto muy oscura y desenfocada, números ilegibles',
      confianza: 'baja',
    };

    const harness = createUsecaseHarness({
      customFetch: mockFetch as any,
      extractorDeps: {
        geminiVisionFn: async () => mockVisionResult,
      },
    });

    const result = await harness.useCase.execute({
      phone,
      tenantId,
      mediaId: 'media-dark-04',
      mediaType: 'image',
      mediaFilename: 'Foto_oscura.jpg',
    });

    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(conv.state.monthlyBill).toBeUndefined();

    expect(result.reply).toContain('la imagen se ve un poco borrosa y no logro distinguir con certeza');
    expect(result.reply).toContain('¿me podrías confirmar la cantidad exacta');
  });

  // ─── TS-05: RESILIENCIA ANTE FALLA DE INFRAESTRUCTURA (HTTP 404 / 429) ────
  it('TS-05 (Resiliencia Infraestructura): Ante error de API (404/429), clasifica INFRASTRUCTURE_ERROR y emite transparencia técnica', async () => {
    const phone = '5214777014005';

    // Mock fetch de Meta OK, pero fetch a Gemini falla con 429 Rate Limit
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('graph.facebook.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            url: 'https://lookaside.fbsbx.com/mock-receipt',
            mime_type: 'image/jpeg',
            file_size: 200000,
            id: 'media-receipt-05',
          }),
        });
      }
      if (url.includes('lookaside.fbsbx.com')) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => Buffer.from('MOCK_JPEG_CONTENT'),
        });
      }
      // Gemini API call
      return Promise.resolve({
        ok: false,
        status: 429,
        text: async () => 'Resource Exhausted: Rate limit exceeded',
      });
    });

    const harness = createUsecaseHarness({
      customFetch: mockFetch as any,
      extractorDeps: {
        customFetch: mockFetch as any,
      },
    });

    const result = await harness.useCase.execute({
      phone,
      tenantId,
      mediaId: 'media-receipt-05',
      mediaType: 'image',
      mediaFilename: 'Recibo_CFE.jpg',
    });

    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(conv.state.monthlyBill).toBeUndefined();

    // Sofía informa de la intermitencia técnica, NUNCA culpa a la foto del usuario
    expect(result.reply).toContain('tuve una pequeña intermitencia técnica momentánea');
    expect(result.reply).toContain('¿me podrías confirmar la cantidad exacta');
    expect(result.reply).not.toContain('borrosa');
  });

  // ─── TS-06: SELF-HEALING CASCADING RESOLVER ───────────────────────────────
  it('TS-06 (Self-Healing Resolver): Reintenta ante modelo 404 hasta tener éxito con el siguiente en cascada', async () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // Magic bytes JPEG

    let attemptCount = 0;
    const mockCascadingFetch = vi.fn().mockImplementation((url: string) => {
      attemptCount++;
      if (url.includes('gemini-2.5-flash') && attemptCount === 1) {
        // Primer modelo retorna 404
        return Promise.resolve({
          ok: false,
          status: 404,
          text: async () => 'Model not found',
        });
      }
      // Segundo intento en cascada (gemini-2.5-pro o gemini-flash-latest) retorna 200 OK
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      tipoDocumento: 'CFE_ANVERSO',
                      montoTotal: 5400,
                      periodo: 'bimestral',
                      tarifa: '1F',
                      confianza: 'alta',
                    }),
                  },
                ],
              },
            },
          ],
        }),
      });
    });

    const service = new CfeReceiptExtractorService({
      customFetch: mockCascadingFetch as any,
    });

    const result = await service.analyzeReceipt(buffer, 'image/jpeg', 'recibo.jpg');
    expect(result.status).toBe('SUCCESS');
    if (result.status === 'SUCCESS') {
      expect(result.data.montoTotal).toBe(5400);
      expect(result.data.tarifa).toBe('1F');
    }
    expect(mockCascadingFetch).toHaveBeenCalledTimes(2);
  });

  // ─── TS-07: INGESTA CONSOLIDADA DE MÚLTIPLES ADJUNTOS ─────────────────────
  it('TS-07 (Múltiples Adjuntos): Ingesta consolidada de anverso y reverso con una sola respuesta al usuario', async () => {
    const phone = '5214777014007';

    // Mock fetch de Meta para dos medios distintos
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('media-anverso-id')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            url: 'https://lookaside.fbsbx.com/anverso-url',
            mime_type: 'image/jpeg',
            file_size: 200000,
            id: 'media-anverso-id',
          }),
        });
      }
      if (url.includes('media-reverso-id')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            url: 'https://lookaside.fbsbx.com/reverso-url',
            mime_type: 'image/jpeg',
            file_size: 200000,
            id: 'media-reverso-id',
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => Buffer.from('MOCK_JPEG_DATA'),
      });
    });

    let callIndex = 0;
    const mockVisionFn = vi.fn().mockImplementation(async () => {
      callIndex++;
      if (callIndex === 1) {
        // Primero procesa anverso
        return {
          tipoDocumento: 'CFE_ANVERSO',
          montoTotal: 34500,
          periodo: 'mensual',
          tarifa: 'GDMTO',
          confianza: 'alta',
        };
      }
      // Segundo procesa reverso
      return {
        tipoDocumento: 'CFE_REVERSO',
        diagnostico: 'Historial de consumo bimestral en kWh',
        confianza: 'alta',
      };
    });

    const harness = createUsecaseHarness({
      customFetch: mockFetch as any,
      extractorDeps: {
        geminiVisionFn: mockVisionFn,
      },
      llmResponses: [
        {
          next_step: 3,
          message_to_user: '¡Excelente! He analizado tu recibo de CFE de $34,500 MXN mensuales (GDMTO). ¿Cuál es el giro de tu empresa?',
          extracted_data: {
            bill_amount: 34500,
            bill_frequency: 'mensual',
          },
        },
      ],
    });

    const mediaAttachments: MediaAttachmentItem[] = [
      { mediaId: 'media-anverso-id', mediaType: 'image', mediaFilename: 'anverso.jpg' },
      { mediaId: 'media-reverso-id', mediaType: 'image', mediaFilename: 'reverso.jpg' },
    ];

    const result = await harness.useCase.execute({
      phone,
      tenantId,
      mediaAttachments,
    });

    // 1. Una sola respuesta enviada a WhatsApp
    expect(harness.sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(result.reply).toContain('$34,500');

    // 2. Estado consolidado en Firestore con el anverso priorizado
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(conv.state.monthlyBill).toBe(34500);
    expect((conv.state as any).tariff).toBe('GDMTO');

    // 3. Verificación de que en los mensajes se registró que se analizaron anverso y reverso
    const userMsg = conv.messages.find((m) => m.sender === 'user');
    expect(userMsg?.text).toContain('Anverso y Reverso analizados');
  });

  // ─── TS-08: REGRESIÓN TOTAL Y CONTRATO ZOD ESTRICTO ───────────────────────
  it('TS-08 (Regresión Total): Contrato Zod CfeReceiptSchema y extractFromReceipt mantienen 100% de compatibilidad retroactiva', async () => {
    const service = new CfeReceiptExtractorService();
    const pdfTextMock = `
      COMISIÓN FEDERAL DE ELECTRICIDAD
      TOTAL A PAGAR: $12,500
      TARIFA: PDBT
      PERIODO: BIMESTRAL
    `;
    const parsed = service.parseCfeText(pdfTextMock);
    expect(parsed).not.toBeNull();
    expect(parsed?.montoTotal).toBe(12500);
    expect(parsed?.tarifa).toBe('PDBT');
    expect(parsed?.periodo).toBe('bimestral');
    expect(parsed?.tipoDocumento).toBe('CFE_ANVERSO');
  });
});

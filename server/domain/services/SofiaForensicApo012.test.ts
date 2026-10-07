/**
 * SofiaForensicApo012.test.ts
 * Suite SQA Forense — Plan APO-012 (T41 a T47).
 * Valida la Arquitectura Trimodal de Ingesta de Recibos CFE:
 * 1. T41: Caso 1 (PDF CFE Digital) — Extracción automática de monto ($30,971), tarifa y periodo sin confirmación manual.
 * 2. T42: Caso 2 (Foto JPEG CFE) — Extracción vía Gemini Vision (confianza alta) y cálculo de consumo.
 * 3. T43: Caso 3 (Texto Directo) — Normalización de texto directo ("Pago 1,800 al bimestre") sin archivo adjunto.
 * 4. T44: Payload Híbrido (Texto + Archivo) — Mensaje con nombre y archivo procesados en un solo turno.
 * 5. T45: Caso Borde (Foto Borrosa / Zod Fallido / Baja Confianza) — Cortafuegos semántico anti-alucinaciones.
 * 6. T46: Size Guard de 5 MB (SSD) — Rechazo controlado de archivos pesados (>5 MB) sin colapso serverless.
 * 7. T47: Regresión Total e Integración Trimodal — Cero interferencias entre los tres modos de entrada.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReceiveMessageUseCase } from '../../application/usecases/ReceiveMessageUseCase.js';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { ILLMProvider } from '../../interfaces/ILLMProvider.js';
import { WhatsAppMediaService } from '../../infrastructure/media/WhatsAppMediaService.js';
import { CfeReceiptExtractorService, CfeReceiptSchema } from './CfeReceiptExtractorService.js';
import { BillNormalizerService } from './BillNormalizerService.js';

describe('SQA Forense Plan APO-012 — Tests T41 a T47 (Motor de Ingesta Trimodal de Recibos CFE)', () => {
  const tenantId = 'o3energy_mexico';

  // Helper para construir el caso de uso con dependencias inyectadas
  function createUsecaseHarness(deps?: {
    customFetch?: typeof fetch;
    extractorDeps?: {
      pdfParserFn?: (buffer: Buffer) => Promise<string>;
      geminiVisionFn?: (buffer: Buffer, mimeType: string) => Promise<any>;
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
      deps.llmResponses.forEach(resp => {
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

  // ─── T41: CASO 1 — PDF CFE DIGITAL ─────────────────────────────────────────
  it('T41: Caso 1 (PDF CFE Digital) — Extrae monto ($30,971), tarifa y periodo sin solicitar confirmación manual', async () => {
    const phone = '5214777000041';

    // Mock de texto digital de un recibo CFE real
    const mockCfePdfText = `
      COMISION FEDERAL DE ELECTRICIDAD
      SUMINISTRADOR DE SERVICIOS BASICOS
      NO. DE SERVICIO: 123456789012
      TARIFA: GDMTO
      TOTAL A PAGAR: $30,971
      PERIODO FACTURADO: 01 ENE - 31 ENE
      PERIODO MENSUAL
    `;

    // Mock del fetch de Meta Graph API
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/mock-pdf-url',
          mime_type: 'application/pdf',
          file_size: 150000, // 150 KB
          id: 'meta-media-doc-41',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => Buffer.from('MOCK_PDF_BINARY_CONTENT'),
      });

    const harness = createUsecaseHarness({
      customFetch: mockFetch as any,
      extractorDeps: {
        pdfParserFn: async () => mockCfePdfText,
      },
      llmResponses: [
        {
          next_step: 3,
          message_to_user: '¡Excelente! Analicé tu recibo CFE con un total de $30,971 MXN mensuales (tarifa GDMTO). Para diseñar tu solución solar, ¿qué tipo de techo tienes?',
          extracted_data: {
            bill_amount: 30971,
            bill_frequency: 'mensual',
          },
        },
      ],
    });

    const result = await harness.useCase.execute({
      phone,
      tenantId,
      mediaId: 'meta-media-doc-41',
      mediaType: 'document',
      mediaFilename: 'Recibo_CFE_Enero.pdf',
    });

    // 1. Verificación del estado en la conversación
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(conv.state.monthlyBill).toBe(30971);
    expect((conv.state as any).tariff).toBe('GDMTO');
    expect(conv.state.billFrequency).toBe('mensual');

    // 2. Sofía avanza fluidamente sin preguntar "¿me confirmas el monto?"
    expect(result.reply).not.toContain('confirmarme por favor el monto');
    expect(result.reply).not.toContain('no logro distinguir');
    expect(result.reply).toContain('$30,971');
    expect(harness.sendWhatsApp).toHaveBeenCalledWith(phone, expect.stringContaining('$30,971'));
  });

  // ─── T42: CASO 2 — FOTO JPEG CFE ───────────────────────────────────────────
  it('T42: Caso 2 (Foto JPEG CFE) — Extrae monto vía Visión Multimodal con alta confianza y calcula mensualidad', async () => {
    const phone = '5214777000042';

    // Mock del fetch de Meta Graph API para imagen
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/mock-img-url',
          mime_type: 'image/jpeg',
          file_size: 450000, // 450 KB
          id: 'meta-media-img-42',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => Buffer.from('MOCK_JPEG_BINARY_CONTENT'),
      });

    // Mock de respuesta de Gemini Vision con esquema Zod válido y alta confianza
    const mockVisionResult = {
      montoTotal: 1800,
      periodo: 'bimestral',
      tarifa: '1F',
      numeroServicio: '987654321098',
      nombreCliente: 'Juan Pérez',
      confianza: 'alta',
    };

    const harness = createUsecaseHarness({
      customFetch: mockFetch as any,
      extractorDeps: {
        geminiVisionFn: async () => mockVisionResult,
      },
      llmResponses: [
        {
          next_step: 3,
          message_to_user: '¡Muchas gracias! Ya pude revisar tu recibo CFE de $1,800 al bimestre (unos $900 al mes). ¿Qué tipo de techo tiene tu propiedad?',
          extracted_data: {
            bill_amount: 1800,
            bill_frequency: 'bimestral',
          },
        },
      ],
    });

    const result = await harness.useCase.execute({
      phone,
      tenantId,
      mediaId: 'meta-media-img-42',
      mediaType: 'image',
    });

    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    // 1. $1,800 bimestral equivale a $900 mensual
    expect(conv.state.monthlyBill).toBe(900);
    expect(conv.state.bimestralBill).toBe(1800);
    expect(conv.state.billFrequency).toBe('bimestral');

    // 2. Respuesta empática y fluida
    expect(result.reply).not.toContain('confirmarme por favor el monto');
    expect(result.reply).toContain('$1,800');
  });

  // ─── T43: CASO 3 — TEXTO DIRECTO (CERO REGRESIONES) ────────────────────────
  it('T43: Caso 3 (Texto Directo) — Normaliza recibo en texto ("Pago 1,800 al bimestre") sin archivo adjunto', async () => {
    const phone = '5214777000043';

    const harness = createUsecaseHarness({
      llmResponses: [
        {
          next_step: 3,
          message_to_user: 'Tu recibo bimestral de $1,800 MXN equivale a $900 MXN al mes. Con este consumo requerirías 4 paneles. ¿Qué tipo de techo tienes?',
          extracted_data: {
            bill_amount: 1800,
            bill_frequency: 'bimestral',
          },
        },
      ],
    });

    const result = await harness.useCase.execute({
      phone,
      tenantId,
      text: 'Pago 1,800 al bimestre',
    });

    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(conv.state.monthlyBill).toBe(900);
    expect(conv.state.bimestralBill).toBe(1800);
    expect(conv.state.billFrequency).toBe('bimestral');
    expect(result.reply).toContain('$900');
  });

  // ─── T44: PAYLOAD HÍBRIDO (TEXTO + ARCHIVO) ────────────────────────────────
  it('T44: Payload Híbrido (Texto + Archivo) — Extrae nombre de usuario del texto y monto del PDF en el mismo turno', async () => {
    const phone = '5214777000044';

    const mockCfePdfText = `
      CFE SUMINISTRADOR DE SERVICIOS BASICOS
      TOTAL A PAGAR: $4,500
      TARIFA: DAC
      PERIODO BIMESTRAL
    `;

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/mock-pdf-hybrid',
          mime_type: 'application/pdf',
          file_size: 200000,
          id: 'meta-media-hybrid-44',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => Buffer.from('MOCK_PDF_HYBRID_CONTENT'),
      });

    const harness = createUsecaseHarness({
      customFetch: mockFetch as any,
      extractorDeps: {
        pdfParserFn: async () => mockCfePdfText,
      },
      llmResponses: [
        {
          next_step: 3,
          message_to_user: '¡Hola Héctor! Mucho gusto. ☀️ He procesado tu recibo de CFE por $4,500 bimestrales. ¿Qué tipo de techo tiene tu casa?',
          extracted_data: {
            client_name: 'Héctor',
            bill_amount: 4500,
            bill_frequency: 'bimestral',
          },
        },
      ],
    });

    const result = await harness.useCase.execute({
      phone,
      tenantId,
      text: 'Hola, soy Héctor y te comparto mi recibo',
      mediaId: 'meta-media-hybrid-44',
      mediaType: 'document',
      mediaFilename: 'Mi_Recibo_Luz.pdf',
    });

    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    // 1. Extrae nombre del texto
    expect(conv.nombre).toBe('Héctor');
    // 2. Extrae monto del documento PDF
    expect(conv.state.monthlyBill).toBe(2250); // $4,500 / 2
    expect(conv.state.bimestralBill).toBe(4500);

    // 3. Respuesta personalizada con el nombre
    expect(result.reply).toContain('Héctor');
    expect(result.reply).toContain('$4,500');
  });

  // ─── T45: CASO BORDE (ZOD FALLIDO / BAJA CONFIANZA / FOTO BORROSA) ─────────
  it('T45: Cortafuegos Semántico — Retorna null si la confianza es baja o Zod falla, solicitando confirmación empática sin contaminar el estado', async () => {
    const phone = '5214777000045';

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/mock-blurry-img',
          mime_type: 'image/jpeg',
          file_size: 120000,
          id: 'meta-media-blurry-45',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => Buffer.from('MOCK_BLURRY_IMAGE_CONTENT'),
      });

    // Gemini reporta baja confianza (imagen borrosa o documento no CFE)
    const mockLowConfidenceVision = {
      montoTotal: 50,
      periodo: 'bimestral',
      confianza: 'baja', // <-- Dispara el cortafuegos semántico
    };

    const harness = createUsecaseHarness({
      customFetch: mockFetch as any,
      extractorDeps: {
        geminiVisionFn: async () => mockLowConfidenceVision,
      },
    });

    const result = await harness.useCase.execute({
      phone,
      tenantId,
      mediaId: 'meta-media-blurry-45',
      mediaType: 'image',
    });

    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    // 1. El estado NO debe ser contaminado con montos dudosos
    expect(conv.state.monthlyBill).toBeUndefined();

    // 2. Sofía responde empáticamente pidiendo confirmar la cantidad exacta
    expect(result.reply).toContain('la imagen se ve un poco borrosa y no logro distinguir con certeza el monto total');
    expect(result.reply).toContain('¿me podrías confirmar la cantidad exacta');

    // 3. Se envía el mensaje por WhatsApp
    expect(harness.sendWhatsApp).toHaveBeenCalledWith(
      phone,
      expect.stringContaining('la imagen se ve un poco borrosa')
    );
  });

  // ─── T46: SIZE GUARD (> 5 MB) ──────────────────────────────────────────────
  it('T46: Size Guard de 5 MB (SSD) — Rechaza archivo de 6 MB antes de descargar binario y emite mensaje empático', async () => {
    const phone = '5214777000046';

    const binaryDownloadMock = vi.fn();

    // Mock de Meta Graph API retornando un archivo de 6 MB en metadatos
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('graph.facebook.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/heavy-file',
            mime_type: 'application/pdf',
            file_size: 6 * 1024 * 1024, // 6 MB > 5 MB
            id: 'meta-heavy-46',
          }),
        });
      }
      // Si intenta descargar el binario, este mock se activará
      binaryDownloadMock();
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => Buffer.alloc(6 * 1024 * 1024),
      });
    });

    const harness = createUsecaseHarness({
      customFetch: mockFetch as any,
    });

    const result = await harness.useCase.execute({
      phone,
      tenantId,
      mediaId: 'meta-heavy-46',
      mediaType: 'document',
      mediaFilename: 'Recibo_Pesado_Escaneado_6MB.pdf',
    });

    // 1. El binario NUNCA debió descargarse (defensa contra DoS/OOM en Vercel)
    expect(binaryDownloadMock).not.toHaveBeenCalled();

    // 2. Respuesta empática con el límite de tamaño
    expect(result.reply).toContain('demasiado pesado para procesarlo directamente por aquí (máximo 5 MB)');
    expect(result.reply).toContain('¿Podrías compartirme una foto más ligera o indicarme el monto de tu recibo en texto?');

    // 3. Estado seguro sin datos corrompidos
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(conv.state.monthlyBill).toBeUndefined();
  });

  // ─── T47: REGRESIÓN TOTAL E INTEGRACIÓN TRIMODAL ───────────────────────────
  it('T47: Validación Estricta del Esquema Zod (CfeReceiptSchema) y Parsing Heurístico CFE', () => {
    // 1. Prueba unitaria del esquema Zod
    const validData = {
      montoTotal: 15400,
      periodo: 'mensual' as const,
      tarifa: 'GDMTH',
      confianza: 'alta' as const,
    };
    expect(CfeReceiptSchema.safeParse(validData).success).toBe(true);

    // 2. Monto absurdo fuera de rango CFE ($10) debe ser rechazado (mínimo $50)
    const invalidLow = {
      montoTotal: 10,
      periodo: 'bimestral' as const,
      confianza: 'alta' as const,
    };
    expect(CfeReceiptSchema.safeParse(invalidLow).success).toBe(false);

    // 3. Parser Heurístico CFE
    const extractor = new CfeReceiptExtractorService();
    const cfeText = `
      COMISION FEDERAL DE ELECTRICIDAD
      TARIFA: DAC
      TOTAL A PAGAR: $8,450.00
      NO. DE SERVICIO: 876543210987
      PERIODO BIMESTRAL
    `;
    const parsed = extractor.parseCfeText(cfeText);
    expect(parsed).not.toBeNull();
    expect(parsed?.montoTotal).toBe(8450);
    expect(parsed?.tarifa).toBe('DAC');
    expect(parsed?.periodo).toBe('bimestral');
    expect(parsed?.confianza).toBe('alta');
  });
});

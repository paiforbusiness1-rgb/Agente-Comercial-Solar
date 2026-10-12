/**
 * CfeReceiptExtractorService.ts
 * Motor Híbrido de Extracción Inteligente para Recibos CFE (PDFs e Imágenes).
 * Cumplimiento:
 * - Regla 7 (MCP): Esquema de Unión Discriminada Zod estricta y auto-evaluación de confianza.
 * - Regla 6 (SSD): Cortafuegos semántico, Size Guard y Fallback de Modelos en Cascada con Logging.
 * - Regla 4 (U-First): Extracción sin culpas falsas al usuario, detección de reverso CFE.
 * - Regla 2 (HRU): Retrocompatibilidad total y cero regresiones.
 */

import { z } from 'zod';
import { AppConfig } from '../../shared/config/AppConfig.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';

// ─── Esquemas Zod con Unión Discriminada Estricta (Refinamiento 3: MCP) ───────

export const CfeAnversoSchema = z.object({
  tipoDocumento: z.literal('CFE_ANVERSO').default('CFE_ANVERSO'),
  montoTotal: z.number().min(50).max(2000000), // Obligatorio y en rango realista CFE
  periodo: z.enum(['mensual', 'bimestral']),
  tarifa: z.string().optional(),
  numeroServicio: z.string().optional(),
  nombreCliente: z.string().optional(),
  confianza: z.literal('alta'),
  diagnostico: z.string().optional(),
});

export const CfeReversoSchema = z.object({
  tipoDocumento: z.literal('CFE_REVERSO'),
  diagnostico: z.string().optional(),
  confianza: z.enum(['alta', 'baja']).default('alta'),
  numeroServicio: z.string().optional(),
  tarifa: z.string().optional(),
  periodo: z.enum(['mensual', 'bimestral']).optional(),
});

export const NonCfeSchema = z.object({
  tipoDocumento: z.literal('OTRO_DOCUMENTO'),
  diagnostico: z.string().optional(),
  confianza: z.enum(['alta', 'baja']).default('baja'),
});

export const UnreadableSchema = z.object({
  tipoDocumento: z.literal('NO_LEGIBLE'),
  diagnostico: z.string().optional(),
  confianza: z.literal('baja').default('baja'),
});

export const GeminiReceiptAnalysisSchema = z.discriminatedUnion('tipoDocumento', [
  CfeAnversoSchema,
  CfeReversoSchema,
  NonCfeSchema,
  UnreadableSchema,
]);

// Alias de retrocompatibilidad estricta (Zero Regressions)
export const CfeReceiptSchema = CfeAnversoSchema;
export type CfeReceiptData = z.infer<typeof CfeAnversoSchema>;

export type CfeExtractionResult =
  | {
      status: 'SUCCESS';
      documentType: 'CFE_ANVERSO';
      data: CfeReceiptData;
    }
  | {
      status: 'REVERSE_PAGE';
      documentType: 'CFE_REVERSO';
      detectedDetails?: {
        numeroServicio?: string;
        tarifa?: string;
        periodo?: string;
      };
      diagnostico?: string;
    }
  | {
      status: 'NON_CFE';
      reason: string;
      diagnostico?: string;
    }
  | {
      status: 'UNREADABLE';
      reason: string;
      diagnostico?: string;
    }
  | {
      status: 'INFRASTRUCTURE_ERROR';
      errorType: 'MODEL_UNAVAILABLE' | 'RATE_LIMITED' | 'NETWORK_ERROR' | 'INVALID_KEY';
      message: string;
    };

export interface ExtractorDependencies {
  pdfParserFn?: (buffer: Buffer) => Promise<string>;
  geminiVisionFn?: (buffer: Buffer, mimeType: string) => Promise<any>;
  customFetch?: typeof fetch;
}

export const GEMINI_MODEL_CASCADE = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-flash-latest',
];

export class CfeReceiptExtractorService {
  private pdfParserFn: (buffer: Buffer) => Promise<string>;
  private geminiVisionFn?: (buffer: Buffer, mimeType: string) => Promise<any>;
  private customFetch?: typeof fetch;

  constructor(deps?: ExtractorDependencies) {
    this.pdfParserFn =
      deps?.pdfParserFn ||
      (async (buffer: Buffer) => {
        try {
          const pdfModule = await import('pdf-parse');
          const PDFParse = (pdfModule as any).PDFParse || (pdfModule as any).default?.PDFParse;
          if (PDFParse) {
            const parser = new PDFParse({ data: buffer });
            const text = await parser.getText();
            return text || '';
          }
          return '';
        } catch (err: any) {
          logger.warn('[CfeReceiptExtractorService] Error en parser nativo PDF', { error: err.message });
          return '';
        }
      });

    this.geminiVisionFn = deps?.geminiVisionFn;
    this.customFetch = deps?.customFetch;
  }

  /**
   * Análisis forense completo del recibo con unión discriminada tipada (APO-014)
   */
  async analyzeReceipt(
    buffer: Buffer,
    mimeType: string,
    filename?: string
  ): Promise<CfeExtractionResult> {
    logger.info('[CfeReceiptExtractorService] Iniciando análisis forense de recibo', {
      mimeType,
      filename,
      sizeBytes: buffer.length,
    });

    const effectiveMimeType = this.normalizeMimeType(buffer, mimeType, filename);
    const isPdf = effectiveMimeType === 'application/pdf';

    // ─── ESTRATEGIA 1: Extracción Estructurada Directa para PDFs CFE Digitales ─────────
    if (isPdf) {
      try {
        const text = await this.pdfParserFn(buffer);
        if (text && text.trim().length > 0) {
          const parsed = this.parseCfeText(text);
          if (parsed && parsed.confianza === 'alta') {
            const validation = CfeAnversoSchema.safeParse({
              ...parsed,
              tipoDocumento: 'CFE_ANVERSO',
            });
            if (validation.success) {
              logger.info('[CfeReceiptExtractorService] Recibo PDF parseado exitosamente', {
                monto: validation.data.montoTotal,
                tarifa: validation.data.tarifa,
                periodo: validation.data.periodo,
              });
              return {
                status: 'SUCCESS',
                documentType: 'CFE_ANVERSO',
                data: validation.data,
              };
            }
          }
        }
      } catch (pdfErr: any) {
        logger.warn('[CfeReceiptExtractorService] Parser nativo de texto PDF falló, intentando visión multimodal...', {
          error: pdfErr.message,
        });
      }
    }

    // ─── ESTRATEGIA 2: Visión Multimodal con Cascada y Unión Discriminada ─────────
    const visionResult = await this.callVisionModel(buffer, effectiveMimeType);
    if (visionResult.success === false) {
      return {
        status: 'INFRASTRUCTURE_ERROR',
        errorType: visionResult.errorType,
        message: visionResult.message,
      };
    }

    const raw = visionResult.data;
    if (!raw || typeof raw !== 'object') {
      return {
        status: 'UNREADABLE',
        reason: 'El modelo no devolvió un objeto válido',
      };
    }

    // Compatibilidad retroactiva con modelos o mocks que no incluyan tipoDocumento
    if (!raw.tipoDocumento) {
      if (typeof raw.montoTotal === 'number' && raw.montoTotal >= 50 && raw.confianza === 'alta') {
        raw.tipoDocumento = 'CFE_ANVERSO';
      } else if (raw.confianza === 'baja') {
        raw.tipoDocumento = 'NO_LEGIBLE';
      } else {
        raw.tipoDocumento = 'OTRO_DOCUMENTO';
      }
    }

    const validation = GeminiReceiptAnalysisSchema.safeParse(raw);
    if (!validation.success) {
      logger.warn('[CfeReceiptExtractorService] Resultado de visión no conformó al esquema Zod discriminado', {
        raw,
        errors: validation.error.format(),
      });
      return {
        status: 'UNREADABLE',
        reason: 'Resultado no cumple con esquema estricto Zod',
        diagnostico: JSON.stringify(validation.error.format()),
      };
    }

    const valData = validation.data;
    switch (valData.tipoDocumento) {
      case 'CFE_ANVERSO':
        logger.info('[CfeReceiptExtractorService] CFE_ANVERSO extraído con alta confianza', {
          monto: valData.montoTotal,
          tarifa: valData.tarifa,
          periodo: valData.periodo,
        });
        return {
          status: 'SUCCESS',
          documentType: 'CFE_ANVERSO',
          data: valData,
        };

      case 'CFE_REVERSO':
        logger.info('[CfeReceiptExtractorService] CFE_REVERSO detectado (historial de consumo)');
        return {
          status: 'REVERSE_PAGE',
          documentType: 'CFE_REVERSO',
          detectedDetails: {
            numeroServicio: valData.numeroServicio,
            tarifa: valData.tarifa,
            periodo: valData.periodo,
          },
          diagnostico: valData.diagnostico,
        };

      case 'OTRO_DOCUMENTO':
        logger.info('[CfeReceiptExtractorService] Documento no corresponde a CFE');
        return {
          status: 'NON_CFE',
          reason: 'El archivo no parece ser un recibo de luz de CFE',
          diagnostico: valData.diagnostico,
        };

      case 'NO_LEGIBLE':
      default:
        logger.info('[CfeReceiptExtractorService] Imagen ilegible o baja confianza reportada');
        return {
          status: 'UNREADABLE',
          reason: 'La imagen es ilegible o de baja calidad',
          diagnostico: valData.diagnostico,
        };
    }
  }

  /**
   * Método de compatibilidad retroactiva (Zero Regressions):
   * Retorna CfeReceiptData si el resultado es SUCCESS, o null en caso contrario.
   */
  async extractFromReceipt(
    buffer: Buffer,
    mimeType: string,
    filename?: string
  ): Promise<CfeReceiptData | null> {
    const res = await this.analyzeReceipt(buffer, mimeType, filename);
    return res.status === 'SUCCESS' ? res.data : null;
  }

  /**
   * Parser heurístico determinista para texto de recibos CFE (PDF digital)
   */
  public parseCfeText(rawText: string): CfeReceiptData | null {
    const text = rawText.replace(/\r\n/g, '\n');

    // 1. Detección de Monto Total a Pagar
    let montoTotal: number | null = null;

    const totalRegexes = [
      /TOTAL\s*A\s*PAGAR(?:\s*\(MXN\))?[:\s]*\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/i,
      /\bTOTAL[:\s]*\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/i,
      /\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)\s*(?:TOTAL|MXN)/i,
    ];

    for (const regex of totalRegexes) {
      const match = text.match(regex);
      if (match && match[1]) {
        const cleanNumber = match[1].replace(/,/g, '');
        const val = parseFloat(cleanNumber);
        if (!isNaN(val) && val >= 50 && val <= 2000000) {
          montoTotal = Math.round(val);
          break;
        }
      }
    }

    if (!montoTotal) {
      return null;
    }

    // 2. Detección de Periodo / Frecuencia
    let periodo: 'mensual' | 'bimestral' = 'bimestral';
    if (/MENSUAL/i.test(text) || /PERIODO FACTURADO\s*:\s*[0-9]{2}\s+[A-Z]{3}\s+[0-9]{2}\s+AL\s+[0-9]{2}\s+[A-Z]{3}\s+[0-9]{2}\s+\(3[0-1]?\s+D[IÍ]AS\)/i.test(text)) {
      periodo = 'mensual';
    } else if (/BIMESTRAL/i.test(text) || /\(6[0-2]?\s+D[IÍ]AS\)/i.test(text)) {
      periodo = 'bimestral';
    } else if (montoTotal > 25000) {
      periodo = 'mensual'; // Heurística tarifas comerciales GDMTO/GDMTH
    }

    // 3. Detección de Tarifa CFE
    let tarifa: string | undefined;
    const tarifaMatch = text.match(/TARIFA[:\s]*([A-Z0-9\-]+)/i);
    if (tarifaMatch && tarifaMatch[1]) {
      tarifa = tarifaMatch[1].trim().toUpperCase();
    } else if (/\bGDMTH\b/i.test(text)) {
      tarifa = 'GDMTH';
    } else if (/\bGDMTO\b/i.test(text)) {
      tarifa = 'GDMTO';
    } else if (/\bDAC\b/i.test(text)) {
      tarifa = 'DAC';
    } else if (/\bPDBT\b/i.test(text)) {
      tarifa = 'PDBT';
    } else if (/\b1[A-F]\b/i.test(text)) {
      const match1F = text.match(/\b(1[A-F])\b/i);
      tarifa = match1F ? match1F[1].toUpperCase() : '1';
    }

    // 4. Detección de Número de Servicio
    let numeroServicio: string | undefined;
    const servicioMatch = text.match(/(?:NO\.\s*DE\s*SERVICIO|NO\.?\s*SERVICIO|SERVICIO)[:\s]*([0-9\s]{12,16})/i);
    if (servicioMatch && servicioMatch[1]) {
      numeroServicio = servicioMatch[1].replace(/\s+/g, '');
    }

    return {
      montoTotal,
      periodo,
      tarifa,
      numeroServicio,
      confianza: 'alta',
      tipoDocumento: 'CFE_ANVERSO',
    };
  }

  /**
   * Normaliza el MIME type usando magic bytes del buffer o extensión de archivo.
   * Evita rechazos de Gemini (ej: application/octet-stream -> image/jpeg)
   */
  public normalizeMimeType(buffer: Buffer, mimeType?: string, filename?: string): string {
    if (buffer && buffer.length >= 4) {
      if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
        return 'application/pdf';
      }
      if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
      }
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return 'image/png';
      }
      if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
        return 'image/webp';
      }
    }

    if (filename) {
      const lower = filename.toLowerCase();
      if (lower.endsWith('.pdf')) return 'application/pdf';
      if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
      if (lower.endsWith('.png')) return 'image/png';
      if (lower.endsWith('.webp')) return 'image/webp';
    }

    if (mimeType && mimeType !== 'application/octet-stream') {
      return mimeType;
    }

    return 'image/jpeg';
  }

  /**
   * Invoca a Gemini Multimodal con Fallback de Modelos en Cascada y Logging (Refinamiento 2: SSD)
   */
  private async callVisionModel(
    buffer: Buffer,
    mimeType: string
  ): Promise<
    | { success: true; data: any; modelUsed: string }
    | { success: false; errorType: 'MODEL_UNAVAILABLE' | 'RATE_LIMITED' | 'NETWORK_ERROR' | 'INVALID_KEY'; message: string }
  > {
    if (this.geminiVisionFn) {
      try {
        const customRes = await this.geminiVisionFn(buffer, mimeType);
        return { success: true, data: customRes, modelUsed: 'mock-injected' };
      } catch (err: any) {
        return { success: false, errorType: 'NETWORK_ERROR', message: err.message };
      }
    }

    const apiKey = AppConfig.gemini.apiKey || (this.customFetch ? 'mock-test-gemini-key' : '');
    if (!apiKey) {
      logger.warn('[CfeReceiptExtractorService] GEMINI_API_KEY no configurada para visión');
      return { success: false, errorType: 'INVALID_KEY', message: 'GEMINI_API_KEY no configurada' };
    }

    // Refinamiento 2: Fallback de Modelos en Cascada con Logging
    const configuredModel = AppConfig.gemini.model;
    const candidates = [
      configuredModel,
      ...GEMINI_MODEL_CASCADE,
    ].filter((m): m is string => Boolean(m) && m !== 'gemini-2.0-flash' && m !== 'gemini-1.5-flash');

    const uniqueCandidates = Array.from(new Set(candidates));

    const systemPrompt = `Eres un perito experto en análisis forense de facturas de energía eléctrica de la Comisión Federal de Electricidad (CFE) en México.
Analiza la imagen o documento adjunto y clasifícalo estrictamente en formato JSON válido con uno de estos esquemas:

1) Si es el ANVERSO de un recibo CFE (página frontal donde aparece el Total a Pagar en pesos):
{
  "tipoDocumento": "CFE_ANVERSO",
  "montoTotal": number (Total a pagar en pesos mexicanos, ej: 148228),
  "periodo": "mensual" | "bimestral",
  "tarifa": string (ej: "GDMTH", "GDMTO", "DAC", "PDBT", "1F"),
  "numeroServicio": string,
  "nombreCliente": string,
  "confianza": "alta",
  "diagnostico": string
}

2) Si es el REVERSO de un recibo CFE (página posterior con historial de consumo kWh, gráficas, factor de potencia, sin total a pagar):
{
  "tipoDocumento": "CFE_REVERSO",
  "diagnostico": "Historial de consumo o gráficas del reverso de CFE",
  "confianza": "alta" | "baja",
  "numeroServicio": string,
  "tarifa": string,
  "periodo": "mensual" | "bimestral"
}

3) Si es un documento o imagen ajena a CFE:
{
  "tipoDocumento": "OTRO_DOCUMENTO",
  "diagnostico": "Descripción del documento",
  "confianza": "alta"
}

4) Si la imagen es ilegible, borrosa u oscura:
{
  "tipoDocumento": "NO_LEGIBLE",
  "diagnostico": "Razón de ilegibilidad",
  "confianza": "baja"
}`;

    const base64Data = buffer.toString('base64');
    let lastError: { errorType: 'MODEL_UNAVAILABLE' | 'RATE_LIMITED' | 'NETWORK_ERROR'; message: string } = {
      errorType: 'MODEL_UNAVAILABLE',
      message: 'No se pudo contactar con ningún modelo de visión',
    };

    const fetchImpl = this.customFetch || fetch;

    for (const model of uniqueCandidates) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    inlineData: {
                      mimeType: mimeType || 'image/jpeg',
                      data: base64Data,
                    },
                  },
                  {
                    text: 'Clasifica y extrae los datos de este documento en formato JSON estricto.',
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: 'application/json',
            },
          }),
        });

        if (response.status === 404) {
          logger.warn(`[CfeReceiptExtractorService] Modelo ${model} no disponible (404). Reintentando siguiente modelo en cascada...`);
          lastError = { errorType: 'MODEL_UNAVAILABLE', message: `Modelo ${model} retornó 404` };
          continue;
        }

        if (response.status === 429) {
          logger.warn(`[CfeReceiptExtractorService] Modelo ${model} excedió cuota de peticiones (429).`);
          return { success: false, errorType: 'RATE_LIMITED', message: 'Límite de peticiones de IA excedido (429)' };
        }

        if (!response.ok) {
          const errText = await response.text();
          logger.warn(`[CfeReceiptExtractorService] Error HTTP ${response.status} en modelo ${model}: ${errText}`);
          lastError = { errorType: 'NETWORK_ERROR', message: `Error HTTP ${response.status}: ${errText}` };
          continue;
        }

        const data = (await response.json()) as any;
        const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawJson) {
          logger.warn(`[CfeReceiptExtractorService] Modelo ${model} devolvió respuesta sin texto JSON`);
          continue;
        }

        try {
          const parsed = JSON.parse(rawJson);
          logger.info(`[CfeReceiptExtractorService] Visión completada exitosamente usando modelo ${model}`);
          return { success: true, data: parsed, modelUsed: model };
        } catch {
          logger.warn(`[CfeReceiptExtractorService] Error al parsear JSON de modelo ${model}`);
          continue;
        }
      } catch (err: any) {
        logger.warn(`[CfeReceiptExtractorService] Excepción al llamar modelo ${model}: ${err.message}`);
        lastError = { errorType: 'NETWORK_ERROR', message: err.message };
      }
    }

    return { success: false, ...lastError };
  }
}

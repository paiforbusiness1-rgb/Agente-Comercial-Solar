/**
 * CfeReceiptExtractorService.ts
 * Motor Híbrido de Extracción Inteligente para Recibos CFE (PDFs e Imágenes).
 * Cumplimiento:
 * - Regla 7 (MCP): Esquema estricto delimitado con Zod y auto-evaluación de confianza.
 * - Regla 6 (SSD): Cortafuegos semántico anti-alucinaciones (retorna null si confianza es baja).
 * - Regla 4 (U-First): Extracción automática con cero transcripción manual para el usuario.
 */

import { z } from 'zod';
import { AppConfig } from '../../shared/config/AppConfig.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';

// ─── Esquema Zod de Validación Estricta (Refinamiento 2: MCP + SSD) ─────────
export const CfeReceiptSchema = z.object({
  montoTotal: z.number().min(50).max(2000000), // Rango realista CFE en MXN ($50 a $2,000,000)
  periodo: z.enum(['mensual', 'bimestral']),
  tarifa: z.string().optional(),
  numeroServicio: z.string().optional(),
  nombreCliente: z.string().optional(),
  confianza: z.enum(['alta', 'baja']),
});

export type CfeReceiptData = z.infer<typeof CfeReceiptSchema>;

export interface ExtractorDependencies {
  pdfParserFn?: (buffer: Buffer) => Promise<string>;
  geminiVisionFn?: (buffer: Buffer, mimeType: string) => Promise<any>;
}

export class CfeReceiptExtractorService {
  private pdfParserFn: (buffer: Buffer) => Promise<string>;
  private geminiVisionFn?: (buffer: Buffer, mimeType: string) => Promise<any>;

  constructor(deps?: ExtractorDependencies) {
    // Parser de PDF por defecto (PDFParse nativo)
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
  }

  /**
   * Extrae deterministamente los datos de un recibo CFE desde un Buffer
   * Retorna CfeReceiptData si la extracción es confiable, o null si es ilegible/invalida.
   */
  async extractFromReceipt(
    buffer: Buffer,
    mimeType: string,
    filename?: string
  ): Promise<CfeReceiptData | null> {
    logger.info('[CfeReceiptExtractorService] Iniciando análisis de recibo', {
      mimeType,
      filename,
      sizeBytes: buffer.length,
    });

    const effectiveMimeType = this.normalizeMimeType(buffer, mimeType, filename);
    const isPdf = effectiveMimeType === 'application/pdf';

    // ─── ESTRATEGIA 1: Extracción Estructurada Directa para PDFs CFE ─────────
    if (isPdf) {
      try {
        const text = await this.pdfParserFn(buffer);
        if (text && text.trim().length > 0) {
          const parsed = this.parseCfeText(text);
          if (parsed && parsed.confianza === 'alta') {
            const validation = CfeReceiptSchema.safeParse(parsed);
            if (validation.success) {
              logger.info('[CfeReceiptExtractorService] Recibo PDF parseado exitosamente', {
                monto: validation.data.montoTotal,
                tarifa: validation.data.tarifa,
                periodo: validation.data.periodo,
              });
              return validation.data;
            }
          }
        }
      } catch (pdfErr: any) {
        logger.warn('[CfeReceiptExtractorService] Extracción de texto PDF falló, intentando visión...', {
          error: pdfErr.message,
        });
      }
    }

    // ─── ESTRATEGIA 2: Visión Multimodal (Gemini Vision Engine) ────────
    try {
      const visionResult = await this.callVisionModel(buffer, effectiveMimeType);
      if (!visionResult) {
        return null;
      }

      // Validación estricta con Zod (Refinamiento 2)
      const validation = CfeReceiptSchema.safeParse(visionResult);
      if (!validation.success) {
        logger.warn('[CfeReceiptExtractorService] Resultado de visión rechazado por esquema Zod', {
          errors: validation.error.format(),
        });
        return null;
      }

      // Cortafuegos semántico: Rechazar si el modelo reporta baja confianza
      if (validation.data.confianza === 'baja') {
        logger.warn('[CfeReceiptExtractorService] Visión reportó baja confianza (posible alucinación/foto borrosa)', {
          resultado: validation.data,
        });
        return null;
      }

      logger.info('[CfeReceiptExtractorService] Visión extrajo datos con alta confianza', {
        monto: validation.data.montoTotal,
        periodo: validation.data.periodo,
        tarifa: validation.data.tarifa,
      });

      return validation.data;
    } catch (visionErr: any) {
      logger.error('[CfeReceiptExtractorService] Error durante visión multimodal', {
        error: visionErr.message,
      });
      return null;
    }
  }

  /**
   * Parser heurístico determinista para texto de recibos CFE (PDF digital)
   */
  public parseCfeText(rawText: string): CfeReceiptData | null {
    const text = rawText.replace(/\r\n/g, '\n');

    // 1. Detección de Monto Total a Pagar
    // Patrones típicos de CFE: "TOTAL A PAGAR: $30,971", "TOTAL A PAGAR (MXN): $30,971.00", "$30,971"
    let montoTotal: number | null = null;

    const totalRegexes = [
      /TOTAL\s*A\s*PAGAR(?:\s*\(MXN\))?[\s:]*\$?[\s]*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/i,
      /IMPORTE\s*A\s*PAGAR[\s:]*\$?[\s]*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/i,
      /\$\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?)/,
    ];

    for (const rx of totalRegexes) {
      const match = text.match(rx);
      if (match && match[1]) {
        const cleanNum = parseFloat(match[1].replace(/,/g, ''));
        if (!isNaN(cleanNum) && cleanNum >= 50 && cleanNum <= 2000000) {
          montoTotal = Math.round(cleanNum);
          break;
        }
      }
    }

    if (!montoTotal) {
      return null;
    }

    // 2. Detección de Tarifa CFE
    let tarifa: string | undefined;
    const tarifaMatch = text.match(/TARIFA[\s:]*([0-9A-Za-z]+)/i);
    if (tarifaMatch && tarifaMatch[1]) {
      tarifa = tarifaMatch[1].toUpperCase().trim();
    }

    // 3. Detección de Número de Servicio
    let numeroServicio: string | undefined;
    const serviceMatch = text.match(/NO\.?\s*DE\s*SERVICIO[\s:]*([0-9\s]{12,18})/i);
    if (serviceMatch && serviceMatch[1]) {
      numeroServicio = serviceMatch[1].replace(/\s/g, '').trim();
    }

    // 4. Detección de Periodo (Mensual vs Bimestral)
    let periodo: 'mensual' | 'bimestral' = 'bimestral';
    if (
      tarifa === 'GDMTO' ||
      tarifa === 'GDMTH' ||
      tarifa === 'PDBT' ||
      /PERIODO\s*MENSUAL/i.test(text) ||
      /CADA\s*MES/i.test(text)
    ) {
      // Tarifas comerciales/industriales de CFE son predominantemente mensuales
      periodo = 'mensual';
    } else if (/BIMESTRE|BIMESTRAL/i.test(text)) {
      periodo = 'bimestral';
    }

    return {
      montoTotal,
      periodo,
      tarifa,
      numeroServicio,
      confianza: 'alta',
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
   * Invoca a Gemini Flash Multimodal para procesar fotos de recibo
   */
  private async callVisionModel(buffer: Buffer, mimeType: string): Promise<any> {
    if (this.geminiVisionFn) {
      return this.geminiVisionFn(buffer, mimeType);
    }

    const apiKey = AppConfig.gemini.apiKey;
    if (!apiKey) {
      logger.warn('[CfeReceiptExtractorService] GEMINI_API_KEY no configurada para visión');
      return null;
    }

    const model = AppConfig.gemini.model || 'gemini-2.5-flash';
    const systemPrompt = `Eres un perito experto en análisis forense de facturas de energía eléctrica de la Comisión Federal de Electricidad (CFE) en México.
Analiza la imagen o documento adjunto y extrae los datos de facturación estrictamente en formato JSON válido con este esquema:
{
  "montoTotal": number (Total a pagar en pesos mexicanos, ej: 30971),
  "periodo": "mensual" | "bimestral",
  "tarifa": string (ej: "GDMTO", "DAC", "PDBT", "1F"),
  "numeroServicio": string,
  "nombreCliente": string,
  "confianza": "alta" | "baja" (Indica "baja" si la imagen es borrosa, no corresponde a un recibo de CFE, o el monto no es legible)
}`;

    const base64Data = buffer.toString('base64');
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(endpoint, {
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
                text: 'Extrae el monto total y datos de este recibo de CFE en formato JSON estricto.',
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

    if (!response.ok) {
      const errText = await response.text();
      logger.error('[CfeReceiptExtractorService] Error llamada Gemini Vision', {
        status: response.status,
        body: errText,
      });
      return null;
    }

    const data = (await response.json()) as any;
    const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawJson) return null;

    try {
      return JSON.parse(rawJson);
    } catch {
      logger.warn('[CfeReceiptExtractorService] Error al parsear JSON devuelto por Gemini');
      return null;
    }
  }
}

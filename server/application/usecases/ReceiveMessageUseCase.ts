/**
 * ReceiveMessageUseCase.ts
 * Caso de Uso Principal para Recepción y Procesamiento de Mensajes de WhatsApp.
 * Arquitectura Trimodal (APO-012):
 * - Caso 1: Documentos PDF (Descarga + Extracción CFE).
 * - Caso 2: Imágenes / Fotos de Recibo (Descarga + OCR Multimodal Vision).
 * - Caso 3: Texto Directo (BillNormalizerService).
 * - Caso Híbrido: Archivo + Texto (Extracción combinada simultánea).
 * - Size Guard (SSD): Protección ante archivos > 5 MB.
 * - Validación Zod (MCP): Cortafuegos semántico contra alucinaciones.
 */

import { IConversationRepository } from '../../domain/repositories/IConversationRepository.js';
import { SofiaFlowOrchestrator } from '../orchestration/SofiaFlowOrchestrator.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';
import { AppConfig } from '../../shared/config/AppConfig.js';
import { WhatsAppMediaService } from '../../infrastructure/media/WhatsAppMediaService.js';
import { CfeReceiptExtractorService, CfeReceiptData } from '../../domain/services/CfeReceiptExtractorService.js';

export interface IncomingMessage {
  phone: string;
  text?: string;
  name?: string;
  tenantId?: string;
  isImage?: boolean; // Compatibilidad legacy
  mediaId?: string;
  mediaType?: 'image' | 'document' | 'audio' | 'video' | 'other';
  mediaFilename?: string;
}

export class ReceiveMessageUseCase {
  private mediaService: WhatsAppMediaService;
  private extractorService: CfeReceiptExtractorService;

  constructor(
    private convRepo: IConversationRepository,
    private orchestrator: SofiaFlowOrchestrator,
    private sendWhatsApp: (phone: string, text: string) => Promise<boolean>,
    private sendWhatsAppMedia: (phone: string, mediaUrl: string, caption?: string) => Promise<boolean>,
    mediaService?: WhatsAppMediaService,
    extractorService?: CfeReceiptExtractorService
  ) {
    this.mediaService = mediaService || new WhatsAppMediaService();
    this.extractorService = extractorService || new CfeReceiptExtractorService();
  }

  async execute(input: IncomingMessage): Promise<{ reply: string; leadGenerated: boolean }> {
    const tenantId = input.tenantId || AppConfig.tenant.defaultId;
    // Preservar número limpio
    const phone = input.phone.replace(/[^\d]/g, '');
    const rawText = input.text || '';
    const text = rawText.trim();

    logger.info('[ReceiveMessageUseCase] Message received', {
      phone,
      tenantId,
      text: text.substring(0, 60),
      isImage: Boolean(input.isImage),
      mediaType: input.mediaType,
      mediaId: input.mediaId,
    });

    let extractedData: CfeReceiptData | null = null;

    // ─── FASE 1: PROCESAMIENTO DE ARCHIVO MULTIMEDIA (PDF O IMAGEN) ─────────
    if (input.mediaId) {
      // 1. Descarga segura con Size Guard de 5 MB (Refinamiento 1: SSD)
      const downloadResult = await this.mediaService.downloadMedia(input.mediaId, input.mediaFilename);

      if (!downloadResult.success) {
        if ('error' in downloadResult && downloadResult.error === 'size_exceeded') {
          const sizeRejectReply =
            'El archivo que enviaste es demasiado pesado para procesarlo directamente por aquí (máximo 5 MB). 📁 ¿Podrías compartirme una foto más ligera o indicarme el monto de tu recibo en texto?';
          const conv = await this.convRepo.findByPhone(tenantId, phone);
          conv.messages.push({
            sender: 'user',
            text: `📎 [Archivo rechazado: ${input.mediaFilename || 'Recibo'} - Tamaño excede 5MB]`,
            timestamp: new Date().toISOString(),
          });
          conv.messages.push({ sender: 'bot', text: sizeRejectReply, timestamp: new Date().toISOString() });
          conv.lastMessageAt = new Date().toISOString();
          await this.convRepo.save(conv);
          await this.sendWhatsApp(phone, sizeRejectReply);
          return { reply: sizeRejectReply, leadGenerated: false };
        } else {
          const fetchFailedReply =
            'Tuve un pequeño problema al descargar tu archivo desde WhatsApp. 📁 ¿Podrías volver a enviármelo o indicarme el monto aproximado de tu recibo en texto?';
          const conv = await this.convRepo.findByPhone(tenantId, phone);
          conv.messages.push({
            sender: 'user',
            text: `📎 [Error al descargar archivo: ${input.mediaFilename || 'Recibo'}]`,
            timestamp: new Date().toISOString(),
          });
          conv.messages.push({ sender: 'bot', text: fetchFailedReply, timestamp: new Date().toISOString() });
          conv.lastMessageAt = new Date().toISOString();
          await this.convRepo.save(conv);
          await this.sendWhatsApp(phone, fetchFailedReply);
          return { reply: fetchFailedReply, leadGenerated: false };
        }
      } else {
        // 2. Extracción Inteligente de Recibo CFE (PDF o Imagen)
        extractedData = await this.extractorService.extractFromReceipt(
          downloadResult.buffer,
          downloadResult.mimeType,
          downloadResult.filename
        );

        const conv = await this.convRepo.findByPhone(tenantId, phone);

        // Caso Borde: Fallo de extracción Zod / Baja confianza (Refinamiento 2)
        if (!extractedData) {
          const fallbackReply =
            'Recibí tu archivo, pero la imagen se ve un poco borrosa y no logro distinguir con certeza el monto total a pagar. Para no darte un cálculo incorrecto, ¿me podrías confirmar la cantidad exacta que aparece en tu recibo?';
          conv.messages.push({
            sender: 'user',
            text: `📎 [Archivo adjuntado: ${input.mediaFilename || 'Recibo CFE'} - Ilegible]`,
            timestamp: new Date().toISOString(),
          });
          conv.messages.push({ sender: 'bot', text: fallbackReply, timestamp: new Date().toISOString() });
          conv.lastMessageAt = new Date().toISOString();
          await this.convRepo.save(conv);
          await this.sendWhatsApp(phone, fallbackReply);
          return { reply: fallbackReply, leadGenerated: false };
        }

        // Caso Exitoso (Caso 1 o Caso 2): Monto extraído con alta confianza
        const mediaLabel =
          input.mediaType === 'document'
            ? `📄 [Documento PDF analizado: ${input.mediaFilename || 'Recibo CFE'} - $${extractedData.montoTotal.toLocaleString('es-MX')} MXN]`
            : `📷 [Foto de recibo analizada: $${extractedData.montoTotal.toLocaleString('es-MX')} MXN]`;

        conv.messages.push({
          sender: 'user',
          text: text ? `${mediaLabel} — "${text}"` : mediaLabel,
          timestamp: new Date().toISOString(),
        });
        await this.convRepo.save(conv);
      }
    } else if (input.isImage && (!text || !text.trim())) {
      // Compatibilidad Legacy (APO-008): Imagen sin mediaId directo (Simulador / Pruebas unitarias directas)
      const fallbackReply =
        'He recibido tu imagen. Para asegurarme de leer el monto con total precisión, ¿podrías confirmarme por favor el monto total en pesos que aparece en el recibo? ¡Gracias!';
      const conv = await this.convRepo.findByPhone(tenantId, phone);
      conv.messages.push({ sender: 'user', text: '📷 [Imagen de recibo adjuntada]', timestamp: new Date().toISOString() });
      conv.messages.push({ sender: 'bot', text: fallbackReply, timestamp: new Date().toISOString() });
      conv.lastMessageAt = new Date().toISOString();
      await this.convRepo.save(conv);
      await this.sendWhatsApp(phone, fallbackReply);
      return { reply: fallbackReply, leadGenerated: false };
    }

    // ─── FASE 2: ORQUESTACIÓN CONVERSACIONAL (PAYLOADS HÍBRIDOS & TEXTO DIRECTO) ───
    // Si se extrajo un monto del archivo, se inyecta en el orquestador
    const extractedBill = extractedData
      ? {
          amount: extractedData.montoTotal,
          frequency: extractedData.periodo,
          tariff: extractedData.tarifa,
          receiptSource: (input.mediaType === 'document' ? 'pdf' : 'image') as 'pdf' | 'image',
        }
      : undefined;

    // Refinamiento 3: Payload Híbrido -> Si el usuario mandó texto (ej. "Soy Héctor"), se conserva;
    // si no mandó texto, se genera un mensaje contextual para que Sofía formule su respuesta WOW
    const effectiveMessageText = text.length > 0 
      ? text 
      : extractedBill 
      ? `Adjunto mi recibo de luz de ${extractedBill.amount} pesos` 
      : '';

    // 3. Procesar mensaje a través del orquestador de 6 pasos
    const result = await this.orchestrator.processMessage({
      tenantId,
      phone,
      userName: input.name,
      messageText: effectiveMessageText,
      extractedBill,
    });

    // 4. Enviar respuesta textual vía WhatsApp
    if (result.replyText) {
      await this.sendWhatsApp(phone, result.replyText);
    }

    // 5. Enviar recursos multimedia con cadencia humanizada (mínimo 1.2s)
    if (result.mediaSent && result.mediaSent.length > 0) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 1200));
      } catch {
        // Safe timeout fallback
      }
      for (const mediaUrl of result.mediaSent) {
        const caption = this.getMediaCaption(mediaUrl);
        await this.sendWhatsAppMedia(phone, mediaUrl, caption);
      }
    }

    logger.info('[ReceiveMessageUseCase] Execution finished', {
      phone,
      nextStep: result.nextStep,
      botDisabled: result.botDisabled,
    });

    return { reply: result.replyText, leadGenerated: result.botDisabled };
  }

  /**
   * Refinamiento 2 (APO-009): Resolución de Captions basada en diccionario centralizado (HRU)
   */
  public getMediaCaption(url: string): string {
    if (url.includes('FINANCIAMIENTO')) return 'Requisitos y Planes de Financiamiento Solar O3 Energy';
    if (url.includes('INSTALACION_PROFESIONAL')) return 'Información de Servicios e Instalación Profesional O3 Energy';
    return 'Información de O3 Energy'; // Fallback seguro
  }
}

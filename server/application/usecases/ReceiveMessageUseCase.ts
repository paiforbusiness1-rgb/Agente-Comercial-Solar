/**
 * ReceiveMessageUseCase.ts
 * Caso de Uso Principal para Recepción y Procesamiento de Mensajes de WhatsApp.
 * Arquitectura Cuatrimodal (APO-014):
 * - Caso 1: Documentos PDF (Descarga + Extracción CFE).
 * - Caso 2: Imágenes / Fotos de Recibo (Descarga + OCR Multimodal Vision).
 * - Caso 3: Texto Directo (BillNormalizerService).
 * - Caso Híbrido: Archivo + Texto (Extracción combinada simultánea).
 * - Multi-Adjunto (Refinamiento 1): Consolidación de múltiples archivos con una sola respuesta.
 * - Taxonomía U-First (Refinamiento 3): Clasificación empática (Reverso, Ilegible, No-CFE, Falla de Infraestructura).
 * - Size Guard (SSD): Protección ante archivos > 5 MB.
 * - Validación Zod (MCP): Unión discriminada estricta anti-alucinaciones.
 */

import { IConversationRepository } from '../../domain/repositories/IConversationRepository.js';
import { SofiaFlowOrchestrator } from '../orchestration/SofiaFlowOrchestrator.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';
import { AppConfig } from '../../shared/config/AppConfig.js';
import { WhatsAppMediaService } from '../../infrastructure/media/WhatsAppMediaService.js';
import {
  CfeReceiptExtractorService,
  CfeReceiptData,
  CfeExtractionResult,
} from '../../domain/services/CfeReceiptExtractorService.js';
import { BillNormalizerService } from '../../domain/services/BillNormalizerService.js';

export interface MediaAttachmentItem {
  mediaId: string;
  mediaType?: 'image' | 'document' | 'audio' | 'video' | 'other';
  mediaFilename?: string;
}

export interface IncomingMessage {
  phone: string;
  text?: string;
  name?: string;
  tenantId?: string;
  isImage?: boolean; // Compatibilidad legacy
  mediaId?: string;
  mediaType?: 'image' | 'document' | 'audio' | 'video' | 'other';
  mediaFilename?: string;
  mediaAttachments?: MediaAttachmentItem[]; // Refinamiento 1 (APO-014)
  inboundTimestamp?: string; // Refinamiento 3 (APO-017)
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
    const phone = input.phone.replace(/[^\d]/g, '');
    const rawText = input.text || '';
    const text = rawText.trim();
    const inboundTimestamp = input.inboundTimestamp || new Date().toISOString();

    logger.info('[ReceiveMessageUseCase] Message received', {
      phone,
      tenantId,
      text: text.substring(0, 60),
      isImage: Boolean(input.isImage),
      mediaType: input.mediaType,
      mediaId: input.mediaId,
      attachmentsCount: input.mediaAttachments?.length || (input.mediaId ? 1 : 0),
    });

    let extractedData: CfeReceiptData | null = null;
    let successfulReceiptSource: 'pdf' | 'image' = input.mediaType === 'document' ? 'pdf' : 'image';
    let reverseDetected = false;
    let bothPagesAnalyzed = false;

    // ─── FASE 1: PROCESAMIENTO DE ARCHIVOS MULTIMEDIA (REF. 1: CONSOLIDACIÓN MULTI-ADJUNTO) ───
    const rawAttachments: MediaAttachmentItem[] =
      input.mediaAttachments && input.mediaAttachments.length > 0
        ? input.mediaAttachments
        : input.mediaId
        ? [{ mediaId: input.mediaId, mediaType: input.mediaType, mediaFilename: input.mediaFilename }]
        : [];

    if (rawAttachments.length > 0) {
      let primarySuccessData: CfeReceiptData | null = null;
      let nonCfeDetected = false;
      let unreadableDetected = false;
      let infraError: { errorType: string; message: string } | null = null;
      let sizeExceeded = false;
      let fetchFailed = false;
      const processedLabels: string[] = [];

      for (const att of rawAttachments) {
        const downloadResult = await this.mediaService.downloadMedia(att.mediaId, att.mediaFilename);
        if (!downloadResult.success) {
          if ('error' in downloadResult && downloadResult.error === 'size_exceeded') {
            sizeExceeded = true;
          } else {
            fetchFailed = true;
          }
          continue;
        }

        const analysis: CfeExtractionResult = await this.extractorService.analyzeReceipt(
          downloadResult.buffer,
          downloadResult.mimeType,
          downloadResult.filename
        );

        if (analysis.status === 'SUCCESS') {
          if (!primarySuccessData) {
            primarySuccessData = analysis.data;
            successfulReceiptSource = att.mediaType === 'document' ? 'pdf' : 'image';
            const label =
              att.mediaType === 'document'
                ? `📄 [Documento PDF analizado: ${att.mediaFilename || 'Recibo CFE'} - $${analysis.data.montoTotal.toLocaleString('es-MX')} MXN]`
                : `📷 [Foto de recibo analizada: $${analysis.data.montoTotal.toLocaleString('es-MX')} MXN]`;
            processedLabels.push(label);
          }
        } else if (analysis.status === 'REVERSE_PAGE') {
          reverseDetected = true;
          processedLabels.push(`📄 [Reverso de recibo CFE detectado: Historial de consumo]`);
        } else if (analysis.status === 'NON_CFE') {
          nonCfeDetected = true;
          processedLabels.push(`📎 [Archivo adjuntado: ${att.mediaFilename || 'Documento'} - No corresponde a CFE]`);
        } else if (analysis.status === 'UNREADABLE') {
          unreadableDetected = true;
          processedLabels.push(`📎 [Archivo adjuntado: ${att.mediaFilename || 'Recibo CFE'} - Ilegible]`);
        } else if (analysis.status === 'INFRASTRUCTURE_ERROR') {
          infraError = { errorType: analysis.errorType, message: analysis.message };
          processedLabels.push(`⚠️ [Intermitencia técnica al procesar ${att.mediaFilename || 'archivo'}]`);
        }
      }

      const conv = await this.convRepo.findByPhone(tenantId, phone);

      // CASO A: Se extrajo con éxito el Anverso (incluso si venía acompañado de un reverso o reverso previo)
      if (primarySuccessData) {
        extractedData = primarySuccessData;
        bothPagesAnalyzed = reverseDetected || Boolean(conv.state?.reversePageReceived);
        const mainLabel = processedLabels[0] || `📄 [Recibo CFE analizado: $${extractedData.montoTotal.toLocaleString('es-MX')} MXN]`;
        const extraNote = bothPagesAnalyzed ? ' (Anverso y Reverso analizados)' : '';
        conv.messages.push({
          sender: 'user',
          text: text ? `${mainLabel}${extraNote} — "${text}"` : `${mainLabel}${extraNote}`,
          timestamp: inboundTimestamp,
        });
        conv.state.reversePageReceived = false;
        conv.state.lastBillExtractedAt = new Date().toISOString();
        await this.convRepo.save(conv);
      }
      // CASO B: No hubo anverso válido en esta petición, responder según taxonomía U-First consolidada
      else {
        let fallbackReply = '';
        let userNote = '';

        if (reverseDetected) {
          const hasExistingBill = Boolean(conv.state?.monthlyBill || conv.state?.bimestralBill);
          const isPostQualificationPhase = conv.state?.phase && conv.state.phase !== 'GREETING' && conv.state.phase !== 'QUALIFICATION';
          const hasQuoteSent = Boolean(conv.state?.completedSteps?.includes('QUOTE_SENT'));
          const recentBillExtracted = Boolean(
            conv.state?.lastBillExtractedAt &&
            Date.now() - new Date(conv.state.lastBillExtractedAt).getTime() < 30000
          );

          if (hasExistingBill || isPostQualificationPhase || hasQuoteSent || recentBillExtracted) {
            // Escenario 1: Reverso Complementario Posterior (T50) o ráfaga multi-webhook reciente (T48)
            logger.info('[ReceiveMessageUseCase] Reverse page received as supplementary document', { phone });
            userNote = '📄 [Reverso de recibo CFE complementario: Historial de consumo analizado]';
            conv.messages.push({ sender: 'user', text: userNote, timestamp: inboundTimestamp });

            // Si el anverso fue procesado en los últimos 30 segundos, suprimir respuesta duplicada para no interrumpir (T48)
            if (recentBillExtracted) {
              await this.convRepo.save(conv);
              return { reply: '', leadGenerated: false };
            }

            // Si fue enviado tiempo después, confirmar recepción contextualmente sin pedir el anverso de nuevo (T50)
            fallbackReply =
              '¡Muchas gracias! Recibí el historial de consumo complementario de tu recibo CFE 📄. Ya contamos con tu propuesta; ¿tienes alguna duda sobre el sistema o te gustaría ver opciones de financiamiento?';
            conv.messages.push({ sender: 'bot', text: fallbackReply, timestamp: new Date().toISOString() });
            conv.lastMessageAt = new Date().toISOString();
            await this.convRepo.save(conv);
            await this.sendWhatsApp(phone, fallbackReply);
            return { reply: fallbackReply, leadGenerated: false };
          }

          // Escenario 2: Reverso Temprano / Sin Anverso Aún (Refinamiento 2 - Caso Borde "Reverso Primero" T49)
          if (!conv.state?.reversePageReceived) {
            logger.info('[ReceiveMessageUseCase] First reverse page detected without bill. Buffering silently for concurrent anverso.', { phone });
            conv.state.reversePageReceived = true;
            conv.state.reversePageReceivedAt = new Date().toISOString();
            userNote = '📄 [Reverso de recibo CFE detectado: Historial de consumo]';
            conv.messages.push({ sender: 'user', text: userNote, timestamp: inboundTimestamp });
            await this.convRepo.save(conv);
            // Silencio intencional: NO se llama a sendWhatsApp para evitar contradicción si el anverso viene en camino
            return { reply: '', leadGenerated: false };
          }

          // Escenario 3: Segundo reverso consecutivo sin anverso
          fallbackReply =
            '¡Excelente! Recibí el historial de consumo de tu recibo CFE 📄. Para elaborar tu propuesta de ahorro solar con tu tarifa actual, ¿podrías compartirme también el anverso (donde aparece el Total a Pagar en pesos) o confirmarme tu monto promedio?';
          userNote = '📄 [Reverso de recibo CFE adjuntado: Historial de consumo]';
          conv.state.reversePageReceived = false;
        } else if (infraError) {
          fallbackReply =
            'Recibí tu recibo de CFE 📄, pero tuve una pequeña intermitencia técnica momentánea al leer los datos de forma automática. Para no hacerte esperar, ¿me podrías confirmar la cantidad exacta que aparece en tu recibo?';
          userNote = `⚠️ [Intermitencia técnica al procesar archivo: ${infraError.errorType}]`;
        } else if (sizeExceeded) {
          fallbackReply =
            'El archivo que enviaste es demasiado pesado para procesarlo directamente por aquí (máximo 5 MB). 📁 ¿Podrías compartirme una foto más ligera o indicarme el monto de tu recibo en texto?';
          userNote = `📎 [Archivo rechazado: ${rawAttachments[0]?.mediaFilename || 'Recibo'} - Tamaño excede 5MB]`;
        } else if (fetchFailed) {
          fallbackReply =
            'Tuve un pequeño problema al descargar tu archivo desde WhatsApp. 📁 ¿Podrías volver a enviármelo o indicarme el monto aproximado de tu recibo en texto?';
          userNote = `📎 [Error al descargar archivo: ${rawAttachments[0]?.mediaFilename || 'Recibo'}]`;
        } else if (nonCfeDetected) {
          fallbackReply =
            'Recibí tu archivo, pero parece que no corresponde a una factura de CFE 📄. ¿Podrías compartirme tu factura de luz de CFE o indicarme cuánto pagas al bimestre/mes?';
          userNote = `📎 [Archivo adjuntado: ${rawAttachments[0]?.mediaFilename || 'Documento'} - No corresponde a CFE]`;
        } else {
          // unreadableDetected o default
          fallbackReply =
            'Recibí tu archivo, pero la imagen se ve un poco borrosa y no logro distinguir con certeza el monto total a pagar. Para no darte un cálculo incorrecto, ¿me podrías confirmar la cantidad exacta que aparece en tu recibo?';
          userNote = `📎 [Archivo adjuntado: ${rawAttachments[0]?.mediaFilename || 'Recibo CFE'} - Ilegible]`;
        }

        conv.messages.push({
          sender: 'user',
          text: userNote,
          timestamp: inboundTimestamp,
        });
        conv.messages.push({ sender: 'bot', text: fallbackReply, timestamp: new Date().toISOString() });
        conv.lastMessageAt = new Date().toISOString();
        await this.convRepo.save(conv);
        await this.sendWhatsApp(phone, fallbackReply);
        return { reply: fallbackReply, leadGenerated: false };
      }
    } else if (input.isImage && (!text || !text.trim())) {
      // Compatibilidad Legacy (APO-008): Imagen sin mediaId directo (Simulador / Pruebas unitarias directas)
      const fallbackReply =
        'He recibido tu imagen. Para asegurarme de leer el monto con total precisión, ¿podrías confirmarme por favor el monto total en pesos que aparece en el recibo? ¡Gracias!';
      const conv = await this.convRepo.findByPhone(tenantId, phone);
      conv.messages.push({ sender: 'user', text: '📷 [Imagen de recibo adjuntada]', timestamp: inboundTimestamp });
      conv.messages.push({ sender: 'bot', text: fallbackReply, timestamp: new Date().toISOString() });
      conv.lastMessageAt = new Date().toISOString();
      await this.convRepo.save(conv);
      await this.sendWhatsApp(phone, fallbackReply);
      return { reply: fallbackReply, leadGenerated: false };
    }

    // ─── FASE 1.5: INTERACCIÓN POSTERIOR CON REVERSO HUÉRFANO PENDIENTE (T51) ───
    const currentConv = await this.convRepo.findByPhone(tenantId, phone);
    if (currentConv.state?.reversePageReceived && !currentConv.state.monthlyBill && !extractedData) {
      const userMentionedBill = BillNormalizerService.preParseUserText(text);
      if (!userMentionedBill) {
        const fallbackReply =
          '¡Excelente! Recibí el historial de consumo de tu recibo CFE 📄. Para elaborar tu propuesta de ahorro solar con tu tarifa actual, ¿podrías compartirme también el anverso (donde aparece el Total a Pagar en pesos) o confirmarme tu monto promedio?';
        currentConv.messages.push({ sender: 'user', text, timestamp: inboundTimestamp });
        currentConv.messages.push({ sender: 'bot', text: fallbackReply, timestamp: new Date().toISOString() });
        currentConv.state.reversePageReceived = false;
        currentConv.lastMessageAt = new Date().toISOString();
        await this.convRepo.save(currentConv);
        await this.sendWhatsApp(phone, fallbackReply);
        return { reply: fallbackReply, leadGenerated: false };
      }
    }

    // ─── FASE 2: ORQUESTACIÓN CONVERSACIONAL (PAYLOADS HÍBRIDOS & TEXTO DIRECTO) ───
    bothPagesAnalyzed = bothPagesAnalyzed || (extractedData ? (reverseDetected || Boolean(currentConv.state?.reversePageReceived)) : false);
    const extractedBill = extractedData
      ? {
          amount: extractedData.montoTotal,
          frequency: extractedData.periodo,
          tariff: extractedData.tarifa,
          receiptSource: successfulReceiptSource,
          bothPagesAnalyzed,
        }
      : undefined;

    const effectiveMessageText =
      text.length > 0
        ? text
        : extractedBill
        ? `Adjunto mi recibo de luz de ${extractedBill.amount} pesos`
        : '';

    // REFINAMIENTO B (APO-018): Guardar Mensaje del Usuario Primero (Disco Seguro antes de IA)
    const lastMsg = currentConv.messages[currentConv.messages.length - 1];
    const alreadySaved = lastMsg && lastMsg.sender === 'user' && lastMsg.timestamp === inboundTimestamp;
    if (!alreadySaved && effectiveMessageText) {
      currentConv.messages.push({
        sender: 'user',
        text: effectiveMessageText,
        timestamp: inboundTimestamp,
      });
      currentConv.lastMessageAt = inboundTimestamp;
      await this.convRepo.save(currentConv); // 👈 DISCO SEGURO: Persistido en Firestore antes de llamar a IA
    }

    // 3. Procesar mensaje a través del orquestador de 6 pasos (con Circuit Breaker y degradación elegante)
    let result: { replyText: string; nextStep: number; botDisabled: boolean; mediaSent?: string[] };
    try {
      result = await this.orchestrator.processMessage({
        tenantId,
        phone,
        userName: input.name,
        messageText: effectiveMessageText,
        inboundTimestamp,
        extractedBill,
      });
    } catch (llmErr: any) {
      logger.error('[ReceiveMessageUseCase] Circuit Breaker trip or unhandled LLM error, activating U-First graceful degradation', {
        error: llmErr.message,
        phone,
      });

      const clientName = currentConv.nombre && currentConv.nombre !== 'Cliente' ? currentConv.nombre : '';
      const greeting = clientName ? `¡Hola ${clientName}! 😊` : '¡Hola! 😊';
      const fallbackReply = `${greeting} Recibí tu mensaje. Estamos experimentando una pequeña intermitencia técnica en este momento. Tu información ya quedó registrada y en unos minutos uno de nuestros asesores continuará atendiéndote por aquí.`;

      currentConv.messages.push({
        sender: 'bot',
        text: fallbackReply,
        timestamp: new Date().toISOString(),
      });
      currentConv.lastMessageAt = new Date().toISOString();
      await this.convRepo.save(currentConv);
      await this.sendWhatsApp(phone, fallbackReply);

      return { reply: fallbackReply, leadGenerated: false };
    }

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

  public getMediaCaption(url: string): string {
    if (url.includes('FINANCIAMIENTO')) return 'Requisitos y Planes de Financiamiento Solar O3 Energy';
    if (url.includes('INSTALACION_PROFESIONAL')) return 'Información de Servicios e Instalación Profesional O3 Energy';
    return 'Información de O3 Energy';
  }
}

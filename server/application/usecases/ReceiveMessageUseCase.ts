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
import { IQuoteEngine } from '../../interfaces/IQuoteEngine.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';

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
  private quoteEngine: IQuoteEngine;

  constructor(
    private convRepo: IConversationRepository,
    private orchestrator: SofiaFlowOrchestrator,
    private sendWhatsApp: (phone: string, text: string) => Promise<boolean>,
    private sendWhatsAppMedia: (phone: string, mediaUrl: string, caption?: string) => Promise<boolean>,
    mediaService?: WhatsAppMediaService,
    extractorService?: CfeReceiptExtractorService,
    quoteEngine?: IQuoteEngine
  ) {
    this.mediaService = mediaService || new WhatsAppMediaService();
    this.extractorService = extractorService || new CfeReceiptExtractorService();
    this.quoteEngine = quoteEngine || new SolarQuoteEngine();
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

        const hasExistingBill = Boolean(
          (conv.state?.monthlyBill && conv.state.monthlyBill > 0) ||
          (conv.state?.bimestralBill && conv.state.bimestralBill > 0)
        );

        // ─── REGLA ESTRICTA STATE-AWARE (APO-022 / EXIGENCIAS 2 & 3 DE AUDITORÍA) ───────
        // Si el monto ya fue extraído previamente, NUNCA romper la UX pidiendo el monto de nuevo,
        // ni enviar disculpas ni textos descontextualizados por archivos secundarios/reversos.
        if (hasExistingBill) {
          if (reverseDetected) {
            logger.info('[ReceiveMessageUseCase] Reverse page received as supplementary document with bill already extracted', { phone });
            userNote = '📄 [Reverso de recibo CFE complementario: Historial de consumo analizado]';
          } else if (infraError) {
            logger.warn('[ReceiveMessageUseCase] Secondary media infraError but bill already extracted. Silently ignoring to preserve UX.', { phone, errorType: infraError.errorType });
            userNote = `⚠️ [Intermitencia técnica al procesar archivo secundario: ${infraError.errorType}]`;
          } else if (sizeExceeded) {
            logger.warn('[ReceiveMessageUseCase] Secondary media sizeExceeded but bill already extracted. Silently ignoring to preserve UX.', { phone });
            userNote = `📎 [Archivo secundario excede 5MB: ${rawAttachments[0]?.mediaFilename || 'Archivo'}]`;
          } else if (fetchFailed) {
            logger.warn('[ReceiveMessageUseCase] Secondary media fetchFailed but bill already extracted. Silently ignoring to preserve UX.', { phone });
            userNote = `📎 [Error al descargar archivo secundario: ${rawAttachments[0]?.mediaFilename || 'Archivo'}]`;
          } else if (nonCfeDetected) {
            logger.warn('[ReceiveMessageUseCase] Secondary media nonCfeDetected but bill already extracted. Silently ignoring to preserve UX.', { phone });
            userNote = `📎 [Archivo secundario no corresponde a CFE: ${rawAttachments[0]?.mediaFilename || 'Documento'}]`;
          } else {
            logger.warn('[ReceiveMessageUseCase] Secondary media unreadable but bill already extracted. Silently ignoring to preserve UX.', { phone });
            userNote = `📎 [Archivo secundario ilegible: ${rawAttachments[0]?.mediaFilename || 'Archivo'}]`;
          }

          conv.messages.push({
            sender: 'user',
            text: userNote,
            timestamp: inboundTimestamp,
          });
          conv.lastMessageAt = new Date().toISOString();
          await this.convRepo.save(conv);

          // Silencio activo: Cero mensajes de interrupción, cero WhatsApp spam, preserva flujo activo
          return { reply: '', leadGenerated: false };
        }

        // Si NO hay monto extraído aún (hasExistingBill === false):
        if (reverseDetected) {
          // Escenario 1: Reverso Temprano / Sin Anverso Aún (Refinamiento 2 - Caso Borde "Reverso Primero" T49)
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

          // Escenario 2: Segundo reverso consecutivo sin anverso
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
      let fallbackReply = '';
      let leadGenerated = false;

      // ─── REGLA ESTRICTA STATE-AWARE (APO-023 / EXIGENCIA 1 DE AUDITORÍA) ───────
      const currentPhase = currentConv.state.phase;
      const hasBill = Boolean(
        (currentConv.state.monthlyBill && currentConv.state.monthlyBill > 0) ||
        (currentConv.state.bimestralBill && currentConv.state.bimestralBill > 0)
      );
      const hasRoof = Boolean(currentConv.state.roofType && currentConv.state.roofType !== '');
      const monthlyBillMxn =
        currentConv.state.monthlyBill ||
        (currentConv.state.bimestralBill ? Math.round(currentConv.state.bimestralBill / 2) : 0);

      // CASO 1: AVANCE DETERMINISTA EN RELEVAMIENTO TÉCNICO TRAS RESPUESTA DE SOMBRAS
      // Si el LLM falla, PERO tenemos datos suficientes en Firestore (fase TECHNICAL_SURVEY, monto y techo):
      if (currentPhase === 'TECHNICAL_SURVEY' && hasBill && hasRoof) {
        const shadeKeywords = ['despejado', 'sin sombra', 'sin sombras', 'despejada', 'no hay sombra', 'ninguna', 'cero sombras', 'libre', 'nada'];
        const isCleared = shadeKeywords.some((keyword) => effectiveMessageText.toLowerCase().includes(keyword));
        const hasShade = !isCleared;

        // AVANCE DETERMINISTA SIN LLM
        currentConv.state.hasShade = hasShade;
        currentConv.state.shadowsAssessed = true;
        currentConv.state.shadows_assessed = true;
        currentConv.state.phase = 'QUOTATION';
        currentConv.state.quoteConsentRequested = true;
        if (!currentConv.state.completedSteps.includes('ROOF_CONFIRMED')) {
          currentConv.state.completedSteps.push('ROOF_CONFIRMED');
        }
        if (!currentConv.state.completedSteps.includes('SHADOWS_ASSESSED')) {
          currentConv.state.completedSteps.push('SHADOWS_ASSESSED');
        }

        const quote = this.quoteEngine.calculate(monthlyBillMxn);
        const roofDesc = currentConv.state.roofType;
        const shadeDesc = hasShade ? 'posibles sombras' : 'despejado';
        const displayName = clientName ? `${clientName}` : 'Cliente';

        fallbackReply = `¡Excelente, ${displayName}! Con tu techo de ${roofDesc} y ${shadeDesc}, tu sistema preliminar es de aproximadamente ${quote.panels} paneles solares de alta eficiencia (${quote.systemPowerKw} kWp). ¿Te gustaría que te presente la propuesta preliminar de inversión y ahorro estimado? 😊`;
      }
      // CASO 2: Recibo extraído en este turno vía upload de archivo
      else if (extractedBill && typeof extractedBill.amount === 'number' && extractedBill.amount > 0) {
        currentConv.state.monthlyBill =
          extractedBill.frequency === 'bimestral'
            ? Math.round(extractedBill.amount / 2)
            : extractedBill.amount;
        currentConv.state.bimestralBill =
          extractedBill.frequency === 'bimestral'
            ? extractedBill.amount
            : extractedBill.amount * 2;
        currentConv.state.billFrequency = extractedBill.frequency || 'mensual';
        currentConv.state.phase = 'TECHNICAL_SURVEY';
        (currentConv as any).montoRecibo = `$${extractedBill.amount.toLocaleString('es-MX')} MXN (${extractedBill.frequency || 'mensual'})`;
        currentConv.state.equivalenceStated = true;
        if (!currentConv.state.completedSteps.includes('BILL_NORMALIZED')) {
          currentConv.state.completedSteps.push('BILL_NORMALIZED');
        }

        const namePrefix = clientName ? `¡Excelente, ${clientName}! ` : '¡Excelente! ';
        const pagesNote = extractedBill.bothPagesAnalyzed
          ? 'He analizado con éxito ambas páginas de tu recibo CFE 📄. '
          : '';
        fallbackReply = `${namePrefix}${pagesNote}Recibí tu recibo de CFE por $${extractedBill.amount.toLocaleString('es-MX')} MXN (${extractedBill.frequency || 'mensual'}). Para diseñar tu solución solar a la medida, ¿podrías indicarme qué tipo de techo tienes en tu propiedad (concreto, lámina o teja)? 🏠`;
      }
      // CASO 3: En TECHNICAL_SURVEY con recibo, esperando techo
      else if (currentPhase === 'TECHNICAL_SURVEY' && hasBill && !hasRoof) {
        const roofMatch = /(concreto|l[aá]mina|teja)/i.exec(effectiveMessageText);
        if (roofMatch) {
          currentConv.state.roofType = roofMatch[1].toLowerCase();
          if (!currentConv.state.completedSteps.includes('ROOF_CONFIRMED')) {
            currentConv.state.completedSteps.push('ROOF_CONFIRMED');
          }
          const displayName = clientName ? `, ${clientName}` : '';
          fallbackReply = `¡Excelente${displayName}! Tu techo es de ${currentConv.state.roofType}. Ahora, ¿hay alguna sombra (árboles, tinacos, edificios u otras estructuras) sobre tu techo, o está completamente despejado? ☀️`;
        } else {
          fallbackReply = `${greeting} Para diseñar tu sistema solar a la medida, ¿podrías indicarme qué tipo de techo tienes (concreto, lámina o teja)? 🏠`;
        }
      }
      // CASO 4: En QUOTATION esperando consentimiento, y el usuario dice "sí" / "adelante"
      else if (currentPhase === 'QUOTATION' && hasBill && !currentConv.state.completedSteps.includes('QUOTE_SENT')) {
        const lowerText = effectiveMessageText.toLowerCase().trim();
        const explicitAffirmative = ['si', 'sí', 'adelante', 'por favor', 'muéstramela', 'muestramela', 'ver cotizacion', 'ver cotización', 'claro'].some(k => lowerText === k || lowerText.startsWith(k));
        if (explicitAffirmative) {
          currentConv.state.quoteConsentGiven = true;
          currentConv.state.completedSteps.push('QUOTE_SENT');
          const quote = this.quoteEngine.calculate(monthlyBillMxn, (currentConv.state as any).extraLoads);
          const displayName = clientName ? `, ${clientName}` : '';
          fallbackReply = `¡Con mucho gusto${displayName}! Aquí tienes tu propuesta personalizada:\n\n☀️ *Sistema Propuesto:* ${quote.systemDescription}\n💰 *Inversión Estimada:* ${quote.costFormatted}\n📉 *Ahorro Estimado:* ${quote.monthlySavingsFormatted} al mes (${quote.annualSavingsFormatted} al año)\n⏳ *Retorno de Inversión (ROI):* ~${quote.roiYears} años\n\n${quote.disclaimer}\n\n¿Te gustaría conocer nuestras opciones de financiamiento con pagos mensuales accesibles o prefieres agendar una visita técnica gratuita a tu domicilio? 📅`;
        } else {
          fallbackReply = `${greeting} Recibí tu mensaje. Estamos experimentando una pequeña intermitencia técnica en este momento. Tu información ya quedó registrada y en unos minutos uno de nuestros asesores continuará atendiéndote por aquí.`;
        }
      }
      // CASO 5: FINANCING - Confirmación de brochure
      else if (currentPhase === 'FINANCING' && currentConv.state.financingConsentRequested === true) {
        const affirmativeKeywords = ['si', 'sí', 'por favor', 'adelante', 'mándamelo', 'mandamelo', 'pasamelo', 'pásamelo', 'claro', 'ok', 'bueno', 'dale', 'enviamelo', 'envíamelo'];
        const normalizedMsg = effectiveMessageText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
        const isAffirmative = affirmativeKeywords.some(keyword => {
          const normKey = keyword.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          return normalizedMsg === normKey || normalizedMsg.startsWith(normKey) || normalizedMsg.includes(normKey);
        });

        if (isAffirmative) {
          // Idempotencia: Verificar si el brochure ya fue enviado previamente
          const alreadySent = Boolean(currentConv.state.mediaSentFlags?.financiamiento);
          currentConv.state.financingConsentGiven = true;
          currentConv.state.mediaSentFlags = currentConv.state.mediaSentFlags || {};
          currentConv.state.mediaSentFlags.financiamiento = true;
          currentConv.state.phase = 'CLOSING';

          const displayName = clientName ? `, ${clientName}` : '';
          fallbackReply = `¡Excelente${displayName}! 😊 Te comparto el brochure oficial con todos los requisitos y facilidades de financiamiento. 📄☀️\n\nPara validar tu instalación y dimensionamiento en sitio, ¿te gustaría que coordinemos la visita técnica gratuita de nuestros ingenieros a tu domicilio? 📅`;

          currentConv.messages.push({ sender: 'bot', text: fallbackReply, timestamp: new Date().toISOString() });
          currentConv.messages.push({
            sender: 'bot',
            text: '📄 [Brochure Enviado]: Planes y requisitos de financiamiento solar',
            timestamp: new Date().toISOString(),
          });
          currentConv.lastMessageAt = new Date().toISOString();
          await this.convRepo.save(currentConv);
          await this.sendWhatsApp(phone, fallbackReply);

          if (!alreadySent) {
            // Cadencia humanizada de 1.2s antes del brochure
            try {
              await new Promise(resolve => setTimeout(resolve, 1200));
            } catch {}
            const fallbackMediaUrl = `${AppConfig.mediaBaseUrl}/FINANCIAMIENTO.jpeg`;
            await this.sendWhatsAppMedia(phone, fallbackMediaUrl, 'Requisitos y Planes de Financiamiento Solar O3 Energy');
          }

          return { reply: fallbackReply, leadGenerated: false };
        } else {
          // Si no es afirmativo, verificar si rechaza o prefiere de contado
          const isCash = ['contado', 'directo', 'no', 'ninguno', 'prefiero contado'].some(k => normalizedMsg.includes(k));
          if (isCash) {
            currentConv.state.financingConsentGiven = false;
            currentConv.state.phase = 'CLOSING';
            const displayName = clientName ? `, ${clientName}` : '';
            fallbackReply = `¡Totalmente de acuerdo${displayName}! Contamos con excelentes facilidades para liquidación de contado. Para validar tu instalación y dimensionamiento en sitio, ¿te gustaría que coordinemos la visita técnica gratuita de nuestros ingenieros a tu domicilio? 📅`;
          } else {
            fallbackReply = `${greeting} Recibí tu mensaje. Estamos experimentando una pequeña intermitencia técnica en este momento. Tu información ya quedó registrada y en unos minutos uno de nuestros asesores continuará atendiéndote por aquí.`;
          }
        }
      }
      // CASO 6: FINANCING - Solicitud de opciones de financiamiento desde QUOTATION
      else if (currentPhase === 'QUOTATION' && (
        effectiveMessageText.toLowerCase().includes('financiamiento') ||
        effectiveMessageText.toLowerCase().includes('opciones') ||
        effectiveMessageText.toLowerCase().includes('meses') ||
        effectiveMessageText.toLowerCase().includes('plazos')
      )) {
        currentConv.state.phase = 'FINANCING';
        currentConv.state.financingConsentRequested = true;
        currentConv.state.financingConsentGiven = false;
        const displayName = clientName ? `, ${clientName}` : '';
        const tierCost = this.quoteEngine.calculate(monthlyBillMxn).estimatedCost;
        const m12 = Math.round(tierCost / 12);
        const m24 = Math.round(tierCost / 24);
        const m36 = Math.round(tierCost / 36);
        fallbackReply = `¡Perfecto${displayName}! 😊 Aquí tienes un resumen de nuestras opciones de financiamiento para la inversión de $${tierCost.toLocaleString('es-MX')} MXN:\n\n🔹 *12 meses* – Pago mensual aproximado de $${m12.toLocaleString('es-MX')} MXN.\n🔹 *24 meses* – Pago mensual aproximado de $${m24.toLocaleString('es-MX')} MXN.\n🔹 *36 meses* – Pago mensual aproximado de $${m36.toLocaleString('es-MX')} MXN.\n\nTodas las opciones incluyen la garantía de los paneles, la instalación profesional y el trámite de interconexión con CFE.\n\n¿Te gustaría que te envíe el brochure oficial con los requisitos y pasos para tramitar el financiamiento? 📄`;
      }
      // CASO 7: CLOSING - Confirmación de visita técnica o traspaso a asesor
      else if ((currentPhase === 'CLOSING' || currentPhase === 'FINANCING') && (
        effectiveMessageText.toLowerCase().includes('visita') ||
        effectiveMessageText.toLowerCase().includes('agendar') ||
        effectiveMessageText.toLowerCase().includes('asesor') ||
        effectiveMessageText.toLowerCase().includes('humano') ||
        effectiveMessageText.toLowerCase().includes('contacto') ||
        (currentPhase === 'CLOSING' && ['si', 'sí', 'adelante', 'por favor', 'claro', 'agendemos', 'coordinemos', 'agendar visita'].some(k => effectiveMessageText.toLowerCase().trim().startsWith(k)))
      )) {
        currentConv.state.phase = 'HUMAN_HANDOFF';
        currentConv.state.advisorHandoffProposed = true;
        currentConv.botDisabled = true;
        const displayName = clientName ? ` ${clientName}` : '';
        fallbackReply = `¡Excelente${displayName}! Con mucho gusto. En un momento uno de nuestros asesores especializados de O3 Energy se pondrá en contacto contigo directamente por aquí para coordinar la fecha y hora de tu visita técnica gratuita. ☀️\n\n¡Que tengas un excelente día!`;
        
        await this.orchestrator.triggerLeadHandoff(currentConv, phone, currentConv.nombre || 'Cliente', 'Solicitud de visita técnica gratuita');
        leadGenerated = true;
      }
      // CASO 8: GREETING o QUALIFICATION (Blindaje Universal Pasos 1 y 2 - APO-025)
      else if (currentPhase === 'GREETING' || currentPhase === 'QUALIFICATION') {
        const lowerText = effectiveMessageText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

        // 1. Detección de intención de espera / búsqueda de recibos
        const waitingKeywords = [
          'comparto', 'aguarda', 'espera', 'voy por', 'un momento', 'ahora',
          'ahi van', 'ahi va', 'listo', 'voy', 'dame un minuto', 'dame un momento',
          'ya te los paso', 'te los paso', 'te los mando', 'busco', 'buscando',
          'estoy buscando', 'dejame ver', 'dejame buscar'
        ];
        const isWaiting = waitingKeywords.some(k => lowerText.includes(k.normalize('NFD').replace(/[\u0300-\u036f]/g, '')));

        // 2. Detección de monto de recibo en texto (ej. "pago 1500 bimestrales", "$3000 al mes", "como 2500")
        const billRegex = /(?:pago|consumo|recibo|llega|es de|aprox|alrededor de)?\s*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,6})(?:\s*(?:pesos|mxn))?\s*(bimestral(?:es)?|mensual(?:es)?)?/i;
        const billMatch = billRegex.exec(effectiveMessageText);

        // 3. Detección de nombre en GREETING (ej. "soy Héctor", "me llamo Carlos", o texto de 1-2 palabras)
        const nameMatch = /(?:soy|me llamo|mi nombre es)\s+([a-záéíóúñ]+)/i.exec(effectiveMessageText);

        if (isWaiting) {
          const displayName = clientName || (currentConv.nombre && currentConv.nombre !== 'Cliente' ? currentConv.nombre : 'Cliente');
          fallbackReply = `¡Perfecto, ${displayName}! 😊 Quedo a la espera de tus recibos CFE. Tómate tu tiempo, en cuanto los compartas los analizaré de inmediato para darte la mejor propuesta. ☀️`;
        } else if (billMatch && Number(billMatch[1].replace(/,/g, '')) >= 200) {
          const rawAmount = Number(billMatch[1].replace(/,/g, ''));
          const isBimestral = !billMatch[2] || billMatch[2].toLowerCase().includes('bimestral');
          const monthlyBill = isBimestral ? Math.round(rawAmount / 2) : rawAmount;
          const bimestralBill = isBimestral ? rawAmount : rawAmount * 2;
          const freq = isBimestral ? 'bimestral' : 'mensual';

          currentConv.state.monthlyBill = monthlyBill;
          currentConv.state.bimestralBill = bimestralBill;
          currentConv.state.billFrequency = freq;
          currentConv.state.phase = 'TECHNICAL_SURVEY';
          (currentConv as any).montoRecibo = `$${rawAmount.toLocaleString('es-MX')} MXN (${freq})`;
          currentConv.state.equivalenceStated = true;
          if (!currentConv.state.completedSteps.includes('BILL_NORMALIZED')) {
            currentConv.state.completedSteps.push('BILL_NORMALIZED');
          }

          const displayName = clientName ? `, ${clientName}` : '';
          fallbackReply = `¡Excelente${displayName}! Recibí tu consumo de $${rawAmount.toLocaleString('es-MX')} MXN (${freq}). Para diseñar tu solución solar a la medida, ¿podrías indicarme qué tipo de techo tienes en tu propiedad (concreto, lámina o teja)? 🏠`;
        } else if (currentPhase === 'GREETING' && nameMatch) {
          const extractedName = nameMatch[1].trim();
          const cleanExtractedName = extractedName.charAt(0).toUpperCase() + extractedName.slice(1).toLowerCase();
          currentConv.nombre = cleanExtractedName;
          currentConv.state.phase = 'QUALIFICATION';
          
          fallbackReply = `¡Hola ${cleanExtractedName}! 😊 Para diseñar tu solución solar a la medida, por favor indícame el monto aproximado de tu recibo de luz (bimestral o mensual) o comparte fotos de tu recibo CFE. 📄☀️`;
        } else {
          fallbackReply = `${greeting} Recibí tu mensaje. Estamos experimentando una pequeña intermitencia técnica en este momento. Tu información ya quedó registrada y en unos minutos uno de nuestros asesores continuará atendiéndote por aquí.`;
        }
      } else {
        // Fallback Secundario: Solo si NO hay datos suficientes para continuar deterministamente
        fallbackReply = `${greeting} Recibí tu mensaje. Estamos experimentando una pequeña intermitencia técnica en este momento. Tu información ya quedó registrada y en unos minutos uno de nuestros asesores continuará atendiéndote por aquí.`;
      }

      currentConv.messages.push({
        sender: 'bot',
        text: fallbackReply,
        timestamp: new Date().toISOString(),
      });
      currentConv.lastMessageAt = new Date().toISOString();
      await this.convRepo.save(currentConv);
      await this.sendWhatsApp(phone, fallbackReply);

      return { reply: fallbackReply, leadGenerated: currentConv.botDisabled };
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

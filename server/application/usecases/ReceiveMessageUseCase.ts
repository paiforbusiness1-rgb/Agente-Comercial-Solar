import { IConversationRepository } from '../../domain/repositories/IConversationRepository.js';
import { SofiaFlowOrchestrator } from '../orchestration/SofiaFlowOrchestrator.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';
import { AppConfig } from '../../shared/config/AppConfig.js';

interface IncomingMessage {
  phone: string;
  text?: string;
  name?: string;
  tenantId?: string;
  isImage?: boolean;
}

export class ReceiveMessageUseCase {
  constructor(
    private convRepo: IConversationRepository,
    private orchestrator: SofiaFlowOrchestrator,
    private sendWhatsApp: (phone: string, text: string) => Promise<boolean>,
    private sendWhatsAppMedia: (phone: string, mediaUrl: string, caption?: string) => Promise<boolean>
  ) {}

  async execute(input: IncomingMessage): Promise<{ reply: string; leadGenerated: boolean }> {
    const tenantId = input.tenantId || AppConfig.tenant.defaultId;
    // Preserve exact phone number for accurate Meta Graph API routing (HRU / Bug Prevention)
    const phone = input.phone.replace(/[^\d]/g, '');
    const text = input.text || '';

    logger.info('[ReceiveMessageUseCase] Message received', {
      phone,
      tenantId,
      text: text.substring(0, 60),
      isImage: Boolean(input.isImage),
    });

    // Refinamiento 1 (APO-008): Manejo Elegante de Imágenes (Fallback U-First)
    if (input.isImage && (!text || !text.trim())) {
      const fallbackReply = 'He recibido tu imagen. Para asegurarme de leer el monto con total precisión, ¿podrías confirmarme por favor el monto total en pesos que aparece en el recibo? ¡Gracias!';
      const conv = await this.convRepo.findByPhone(tenantId, phone);
      conv.messages.push({ sender: 'user', text: '📷 [Imagen de recibo adjuntada]', timestamp: new Date().toISOString() });
      conv.messages.push({ sender: 'bot', text: fallbackReply, timestamp: new Date().toISOString() });
      conv.lastMessageAt = new Date().toISOString();
      await this.convRepo.save(conv);
      await this.sendWhatsApp(phone, fallbackReply);
      return { reply: fallbackReply, leadGenerated: false };
    }

    // 1. Process message through 6-step state machine orchestrator
    const result = await this.orchestrator.processMessage({
      tenantId,
      phone,
      userName: input.name,
      messageText: text,
    });

    // 2. Send text response via WhatsApp
    if (result.replyText) {
      await this.sendWhatsApp(phone, result.replyText);
    }

    // 3. Send media attachments with humanized pacing delay (Refinamiento 2: at least 1.2s before media dispatch)
    if (result.mediaSent && result.mediaSent.length > 0) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 1200));
      } catch {
        // Safe timeout fallback
      }
      for (const mediaUrl of result.mediaSent) {
        await this.sendWhatsAppMedia(phone, mediaUrl, 'Información de Servicios e Instalación Profesional O3 Energy');
      }
    }

    logger.info('[ReceiveMessageUseCase] Execution finished', {
      phone,
      nextStep: result.nextStep,
      botDisabled: result.botDisabled,
    });

    return { reply: result.replyText, leadGenerated: result.botDisabled };
  }
}

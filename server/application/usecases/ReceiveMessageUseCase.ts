import { IConversationRepository } from '../../domain/repositories/IConversationRepository.js';
import { SofiaFlowOrchestrator } from '../orchestration/SofiaFlowOrchestrator.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';
import { AppConfig } from '../../shared/config/AppConfig.js';

interface IncomingMessage {
  phone: string;
  text: string;
  name?: string;
  tenantId?: string;
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

    logger.info('[ReceiveMessageUseCase] Message received', {
      phone,
      tenantId,
      text: input.text.substring(0, 60),
    });

    // 1. Process message through 6-step state machine orchestrator
    const result = await this.orchestrator.processMessage({
      tenantId,
      phone,
      userName: input.name,
      messageText: input.text,
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

import { IConversationRepository } from '../../domain/repositories/IConversationRepository.js';
import { LLMOrchestrator } from '../orchestrators/LLMOrchestrator.js';
import { AgentDefinition } from '../../interfaces/IAgentFactory.js';
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
    private orchestrator: LLMOrchestrator,
    private agent: AgentDefinition,
    private sendWhatsApp: (phone: string, text: string) => Promise<boolean>,
  ) {}

  async execute(input: IncomingMessage): Promise<{ reply: string; leadGenerated: boolean }> {
    const tenantId = input.tenantId || AppConfig.tenant.defaultId;
    // Preserve exact phone number for accurate Meta Graph API routing
    const phone = input.phone.replace(/[^\d]/g, '');

    logger.info('[ReceiveMessageUseCase] Message received', { phone, tenantId, text: input.text.substring(0, 60) });

    // Load conversation from repository
    let conversation = await this.convRepo.findByPhone(tenantId, phone);

    // Update name if we have one and it was generic
    if (input.name && conversation.nombre === 'Cliente') {
      conversation.nombre = input.name;
    }

    // If bot is disabled (human handoff), just store message and return
    if (conversation.botDisabled) {
      conversation.messages.push({ sender: 'user', text: input.text, timestamp: new Date().toISOString() });
      conversation.lastMessageAt = new Date().toISOString();
      await this.convRepo.save(conversation);
      logger.info('[ReceiveMessageUseCase] Bot disabled — message stored for human agent', { phone });
      return { reply: '', leadGenerated: false };
    }

    // Run the agent
    const { replyText, updatedConversation, leadGenerated } = await this.orchestrator.run(
      this.agent,
      conversation,
      input.text,
    );

    // Persist updated conversation
    await this.convRepo.save(updatedConversation);

    // Send WhatsApp reply
    if (replyText) {
      await this.sendWhatsApp(phone, replyText);
    }

    logger.info('[ReceiveMessageUseCase] Done', { phone, leadGenerated, replyLength: replyText.length });
    return { reply: replyText, leadGenerated };
  }
}

/**
 * SofiaFlowOrchestrator.ts
 * Manages the 6-step state machine for Sofía IA (O3 Energy México).
 * Anti-God-Object Architecture: Decouples state flow, prompt building, quote generation, and handoff.
 */

import { IConversationRepository } from '../../domain/repositories/IConversationRepository.js';
import { ILeadRepository } from '../../domain/repositories/ILeadRepository.js';
import { Lead } from '../../domain/entities/Lead.js';
import { IQuoteEngine } from '../../interfaces/IQuoteEngine.js';
import { ILLMProvider } from '../../interfaces/ILLMProvider.js';
import { SofiaPromptBuilder, SofiaLlmResponse } from '../builders/SofiaPromptBuilder.js';
import { QuotePdfService } from '../../infrastructure/services/QuotePdfService.js';
import { AppConfig } from '../../shared/config/AppConfig.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';

export interface IEmailNotificationService {
  sendLeadNotification(leadData: { leadName: string; phone: string; monthlyBill: number; notes?: string }): Promise<boolean>;
}

export interface OrchestrationInput {
  tenantId: string;
  phone: string;
  userName?: string;
  messageText: string;
}

export interface OrchestrationOutput {
  replyText: string;
  nextStep: number;
  botDisabled: boolean;
  mediaSent?: string[];
}

export class SofiaFlowOrchestrator {
  constructor(
    private conversationRepo: IConversationRepository,
    private leadRepo: ILeadRepository,
    private quoteEngine: IQuoteEngine,
    private llmProvider: ILLMProvider,
    private sendWhatsAppText: (phone: string, text: string) => Promise<boolean>,
    private emailService: IEmailNotificationService
  ) {}

  public async processMessage(input: OrchestrationInput): Promise<OrchestrationOutput> {
    const { tenantId, phone, userName, messageText } = input;

    // 1. Fetch conversation state from persistent repository (Zero Regressions)
    const conv = await this.conversationRepo.findByPhone(tenantId, phone);

    // Ensure state collections exist
    if (!conv.state.completedSteps) {
      conv.state.completedSteps = [];
    }

    // If bot is disabled (Human Handoff Active), do not intervene automatically
    if (conv.botDisabled) {
      logger.info(`[SofiaFlowOrchestrator] Bot disabled for ${phone}. Skipping automated response.`);
      return { replyText: '', nextStep: 6, botDisabled: true };
    }

    // Determine step integer (1 to 6)
    const currentStepInt = this.phaseToStepInt(conv.state.phase);

    // 2. Build MCP Prompt with XML tag encapsulation (SSD & MCP Rules)
    const promptCtx = {
      phone,
      userName: userName || conv.nombre,
      currentStep: currentStepInt,
      extractedData: {
        billAmount: conv.state.monthlyBill,
        roofType: conv.state.roofType,
        meterDistance: (conv.state as any).meterDistance,
        extraLoads: (conv.state as any).extraLoads,
        location: (conv.state as any).location,
        ownership: conv.state.isOwner ? 'Propio' : undefined,
      },
      botDisabled: conv.botDisabled,
      latestUserMessage: messageText,
      historySummary: conv.messages.slice(-6).map(m => `${m.sender}: ${m.text}`).join('\n'),
    };

    const { systemPrompt, userContent } = SofiaPromptBuilder.buildPrompt(promptCtx);

    // 3. Invoke LLM Provider
    const rawLlmOutput = await this.llmProvider.complete(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      [],
      0.2
    );

    const parsed: SofiaLlmResponse = SofiaPromptBuilder.parseResponse(rawLlmOutput.text || '');

    const mediaSent: string[] = [];
    let finalReply = parsed.message_to_user;

    // 4. Update internal state from LLM extracted data
    if (parsed.extracted_data) {
      if (parsed.extracted_data.bill_amount) {
        conv.state.monthlyBill = parsed.extracted_data.bill_amount;
        (conv as any).montoRecibo = `$${parsed.extracted_data.bill_amount} MXN`;
      }
      if (parsed.extracted_data.roof_type) {
        conv.state.roofType = parsed.extracted_data.roof_type;
      }
      if (parsed.extracted_data.ownership) {
        conv.state.isOwner = parsed.extracted_data.ownership.toLowerCase().includes('propi') || parsed.extracted_data.ownership.toLowerCase().includes('propia');
      }
      if (parsed.extracted_data.meter_distance) {
        (conv.state as any).meterDistance = parsed.extracted_data.meter_distance;
      }
      if (parsed.extracted_data.location) {
        (conv.state as any).location = parsed.extracted_data.location;
      }
    }

    // Check step 4 — dynamic quote generation ONCE per conversation flow or if explicitly re-requested
    const userExplicitlyRequestedQuote = messageText.toLowerCase().includes('cotizac') || 
                                         messageText.toLowerCase().includes('presupuesto') || 
                                         messageText.toLowerCase().includes('dame el precio') ||
                                         messageText.toLowerCase().includes('cuanto cuesta');

    const isQuoteNotYetSent = !conv.state.completedSteps.includes('QUOTE_SENT');
    const isEnteringStep4 = parsed.next_step === 4 || (currentStepInt < 4 && parsed.next_step >= 4);

    if ((isEnteringStep4 && isQuoteNotYetSent) || (userExplicitlyRequestedQuote && conv.state.monthlyBill)) {
      const bill = conv.state.monthlyBill || 3500;
      const calcResult = this.quoteEngine.calculate(bill);

      const quoteDto = {
        clientName: conv.nombre || userName || 'Cliente',
        clientPhone: phone,
        monthlyBillMxn: bill,
        panelsCount: calcResult.panels,
        systemPowerKwp: calcResult.systemPowerKw,
        totalCostMxn: calcResult.estimatedCost,
        monthlySavingsMxn: calcResult.monthlySavings,
        annualSavingsMxn: calcResult.annualSavings,
        roofType: conv.state.roofType,
        location: (conv.state as any).location,
      };

      const pdfResult = await QuotePdfService.generateQuote(quoteDto);
      finalReply = `${pdfResult.textSummary}\n\n${parsed.message_to_user}`;
      conv.state.completedSteps.push('QUOTE_SENT');
    }

    // Check media dispatch — send ONCE per media type to avoid duplicate attachments
    if (parsed.media_to_send === 'FINANCIAMIENTO' && !conv.state.completedSteps.includes('MEDIA_FINANCIAMIENTO_SENT')) {
      const imgUrl = `${AppConfig.mediaBaseUrl}/FINANCIAMIENTO.jpeg`;
      mediaSent.push(imgUrl);
      conv.state.completedSteps.push('MEDIA_FINANCIAMIENTO_SENT');
    } else if (parsed.media_to_send === 'INSTALACION_PROFESIONAL' && !conv.state.completedSteps.includes('MEDIA_INSTALACION_SENT')) {
      const imgUrl = `${AppConfig.mediaBaseUrl}/INSTALACION_PROFESIONAL.jpeg`;
      mediaSent.push(imgUrl);
      conv.state.completedSteps.push('MEDIA_INSTALACION_SENT');
    }

    // 5. Check Human Handoff trigger
    let isHandoff = parsed.trigger_human_handoff;
    if (messageText.toLowerCase().includes('asesor') || messageText.toLowerCase().includes('humano') || messageText.toLowerCase().includes('agente')) {
      isHandoff = true;
    }

    if (isHandoff) {
      conv.botDisabled = true;
      conv.state.phase = 'HUMAN_HANDOFF';
      finalReply = `¡Con mucho gusto! En un momento uno de nuestros asesores especializados de O3 Energy se pondrá en contacto contigo directamente a través de este chat para brindarte atención personalizada. ☀️\n\n¡Que tengas un excelente día!`;

      // Save lead and alert sales team via email
      await this.triggerLeadHandoff(conv, phone, userName || conv.nombre, parsed.handoff_reason || 'Solicitud de cliente');
    } else {
      conv.state.phase = this.stepIntToPhase(parsed.next_step);
    }

    // Append messages to conversation history
    conv.messages.push({ sender: 'user', text: messageText, timestamp: new Date().toISOString() });
    conv.messages.push({ sender: 'bot', text: finalReply, timestamp: new Date().toISOString() });
    conv.lastMessageAt = new Date().toISOString();

    // 6. Save state to repository
    await this.conversationRepo.save(conv);

    return {
      replyText: finalReply,
      nextStep: parsed.next_step,
      botDisabled: conv.botDisabled,
      mediaSent: mediaSent.length > 0 ? mediaSent : undefined,
    };
  }

  private phaseToStepInt(phase: string): number {
    switch (phase) {
      case 'GREETING': return 1;
      case 'QUALIFICATION': return 2;
      case 'TECHNICAL_SURVEY': return 3;
      case 'QUOTATION': return 4;
      case 'FINANCING': return 5;
      case 'CLOSING':
      case 'HUMAN_HANDOFF':
      case 'LEAD_GENERATED': return 6;
      default: return 1;
    }
  }

  private stepIntToPhase(step: number): any {
    switch (step) {
      case 1: return 'GREETING';
      case 2: return 'QUALIFICATION';
      case 3: return 'TECHNICAL_SURVEY';
      case 4: return 'QUOTATION';
      case 5: return 'FINANCING';
      case 6: return 'CLOSING';
      default: return 'GREETING';
    }
  }

  private async triggerLeadHandoff(conv: any, phone: string, name: string, reason: string): Promise<void> {
    try {
      const lead: Lead = {
        id: phone,
        tenantId: conv.tenantId,
        phone,
        nombre: name,
        montoRecibo: `$${conv.state.monthlyBill || 0} MXN`,
        sistemaEstimado: `${conv.state.roofType || 'Residencial'}`,
        costoEstimado: 'Cotización solicitada',
        leadScore: 85,
        status: 'pending_review',
        privateNotes: `Lead derivado a asesor humano. Razon: ${reason}`,
        createdAt: new Date().toISOString(),
      };

      await this.leadRepo.save(lead);

      await this.emailService.sendLeadNotification({
        leadName: name,
        phone,
        monthlyBill: conv.state.monthlyBill || 0,
        notes: `Solicitud de atención humana en WhatsApp: ${reason}`,
      });

      logger.info(`[SofiaFlowOrchestrator] Lead handoff email sent for ${phone}`);
    } catch (err: any) {
      logger.error(`[SofiaFlowOrchestrator] Lead handoff email trigger failed:`, err);
    }
  }
}

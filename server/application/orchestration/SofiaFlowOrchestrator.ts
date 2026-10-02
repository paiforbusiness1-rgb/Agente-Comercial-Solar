/**
 * SofiaFlowOrchestrator.ts
 * Manages the 6-step state machine for Sofía IA (O3 Energy México).
 * Anti-God-Object Architecture: Decouples state flow, prompt building, quote generation, and handoff.
 * Implements deterministic quote consent gating, media dispatch idempotency, graceful name capture,
 * single-pass Single Source of Truth calculation injection, and BillNormalizerService integration.
 */

import { IConversationRepository } from '../../domain/repositories/IConversationRepository.js';
import { ILeadRepository } from '../../domain/repositories/ILeadRepository.js';
import { Lead } from '../../domain/entities/Lead.js';
import { IQuoteEngine, QuoteResult } from '../../interfaces/IQuoteEngine.js';
import { ILLMProvider } from '../../interfaces/ILLMProvider.js';
import { SofiaPromptBuilder, SofiaLlmResponse } from '../builders/SofiaPromptBuilder.js';
import { QuotePdfService } from '../../infrastructure/services/QuotePdfService.js';
import { BillNormalizerService } from '../../domain/services/BillNormalizerService.js';
import { AgentNotificationService, ProspectData } from '../../infrastructure/services/AgentNotificationService.js';
import { AgentRepository } from '../../infrastructure/persistence/AgentRepository.js';
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
    private emailService: IEmailNotificationService,
    private db?: any
  ) {}

  public async processMessage(input: OrchestrationInput): Promise<OrchestrationOutput> {
    const { tenantId, phone, userName, messageText } = input;

    // 1. Fetch conversation state from persistent repository (Zero Regressions)
    const conv = await this.conversationRepo.findByPhone(tenantId, phone);

    // Ensure state collections & flags exist
    if (!conv.state.completedSteps) conv.state.completedSteps = [];
    if (!conv.state.mediaSentFlags) conv.state.mediaSentFlags = {};

    // Update name if provided explicitly from WhatsApp profile
    if (userName && userName !== 'Cliente' && conv.nombre === 'Cliente') {
      conv.nombre = userName;
    }

    // If bot is disabled (Human Handoff Active), do not intervene automatically
    if (conv.botDisabled) {
      logger.info(`[SofiaFlowOrchestrator] Bot disabled for ${phone}. Skipping automated response.`);
      return { replyText: '', nextStep: 6, botDisabled: true };
    }

    // Detect returning user context (state-only evaluation — no hardcoded greetings)
    const isReturningContext =
      conv.messages.length >= 2 &&
      conv.nombre !== 'Cliente' &&
      conv.state.phase !== 'GREETING' &&
      conv.state.phase !== 'HUMAN_HANDOFF' &&
      !(conv.state as any).returningUserAcknowledged;

    // Build previous session summary for LLM context
    let previousSessionSummary: string | undefined;
    if (isReturningContext) {
      const bill = conv.state.monthlyBill ? `$${conv.state.monthlyBill} MXN/mes` : null;
      const phase = conv.state.phase;
      const parts = [
        bill ? `recibo de ${bill}` : null,
        phase === 'QUOTATION' || phase === 'FINANCING' ? 'se presentó cotización preliminar' : null,
        phase === 'TECHNICAL_SURVEY' ? 'se evaluaba el sistema técnico' : null,
      ].filter(Boolean);
      previousSessionSummary = parts.length > 0
        ? `Conversación previa: ${parts.join(', ')}.`
        : 'El cliente ha interactuado previamente con Sofía.';
    }

    // Determine step integer (1 to 6)
    const currentStepInt = this.phaseToStepInt(conv.state.phase);

    // 2. Pre-Parse User Message for Bill Amount & Frequency (Single-Pass Zero-Latency)
    const preParsedBill = BillNormalizerService.normalize({
      rawAmount: conv.state.monthlyBill ? (conv.state.billFrequency === 'bimestral' ? (conv.state.bimestralBill || conv.state.monthlyBill * 2) : conv.state.monthlyBill) : null,
      rawFrequency: conv.state.billFrequency,
      messageText,
    });

    if (preParsedBill) {
      conv.state.monthlyBill = preParsedBill.monthlyBill;
      conv.state.bimestralBill = preParsedBill.bimestralBill;
      conv.state.billFrequency = preParsedBill.frequency;
      (conv as any).montoRecibo = preParsedBill.formattedSummary;
    }

    // Pre-Calculate Quote as Single Source of Truth (Prevent LLM Text Hallucinations)
    let calculatedQuoteInfo: { panels: number; systemPowerKw: number; estimatedCost: number; monthlySavings: number; annualSavings: number; rangeLabel: string } | null = null;
    let preCalcResult: QuoteResult | null = null;

    if (conv.state.monthlyBill) {
      preCalcResult = this.quoteEngine.calculate(conv.state.monthlyBill, (conv.state as any).extraLoads);
      calculatedQuoteInfo = {
        panels: preCalcResult.panels,
        systemPowerKw: preCalcResult.systemPowerKw,
        estimatedCost: preCalcResult.estimatedCost,
        monthlySavings: preCalcResult.monthlySavings,
        annualSavings: preCalcResult.annualSavings,
        rangeLabel: preCalcResult.systemDescription,
      };
    }

    // 3. Build MCP Prompt with XML tag encapsulation and pre-calculated quote context
    const promptCtx = {
      phone,
      userName: conv.nombre,
      currentStep: currentStepInt,
      extractedData: {
        billAmount: conv.state.monthlyBill,
        billFrequency: conv.state.billFrequency,
        roofType: conv.state.roofType,
        meterDistance: (conv.state as any).meterDistance,
        extraLoads: (conv.state as any).extraLoads,
        location: (conv.state as any).location,
        ownership: conv.state.isOwner ? 'Propio' : undefined,
      },
      calculatedQuote: calculatedQuoteInfo,
      quoteConsentRequested: conv.state.quoteConsentRequested,
      quoteConsentGiven: conv.state.quoteConsentGiven,
      botDisabled: conv.botDisabled,
      latestUserMessage: messageText,
      historySummary: conv.messages.slice(-6).map(m => `${m.sender}: ${m.text}`).join('\n'),
      isReturningContext,
      previousSessionSummary,
    };

    const { systemPrompt, userContent } = SofiaPromptBuilder.buildPrompt(promptCtx);

    // 4. Invoke LLM Provider
    const rawLlmOutput = await this.llmProvider.complete(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      [],
      0.2
    );

    const parsed: SofiaLlmResponse = SofiaPromptBuilder.parseResponse(rawLlmOutput.text || '');

    if (parsed.returning_user_greeted) {
      (conv.state as any).returningUserAcknowledged = true;
    }

    const mediaSent: string[] = [];
    let finalReply = parsed.message_to_user;

    // 5. Reconcile extracted data from LLM response
    if (parsed.extracted_data) {
      if (parsed.extracted_data.client_name && conv.nombre === 'Cliente') {
        conv.nombre = parsed.extracted_data.client_name;
      }

      // Re-normalize if LLM extracted or updated bill amount/frequency
      if (parsed.extracted_data.bill_amount) {
        const normalized = BillNormalizerService.normalize({
          rawAmount: parsed.extracted_data.bill_amount,
          rawFrequency: parsed.extracted_data.bill_frequency,
          messageText,
        });

        if (normalized) {
          const billChanged = conv.state.monthlyBill !== normalized.monthlyBill;
          conv.state.monthlyBill = normalized.monthlyBill;
          conv.state.bimestralBill = normalized.bimestralBill;
          conv.state.billFrequency = normalized.frequency;
          (conv as any).montoRecibo = normalized.formattedSummary;

          // Dynamic Re-Quotation: If user corrected bill/frequency, clear QUOTE_SENT flag
          if (billChanged && conv.state.completedSteps.includes('QUOTE_SENT')) {
            conv.state.completedSteps = conv.state.completedSteps.filter(step => step !== 'QUOTE_SENT');
          }
        }
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

    // Consent Gating Logic for Quote Generation
    const lowerMessage = messageText.toLowerCase().trim();
    const explicitAffirmative = ['si', 'sí', 'adelante', 'por favor', 'muéstramela', 'muestramela', 'ver cotizacion', 'ver cotización', 'claro'].some(k => lowerMessage === k || lowerMessage.startsWith(k));

    if (parsed.quote_consent_requested) {
      conv.state.quoteConsentRequested = true;
    }

    if (parsed.quote_consent_given || (conv.state.quoteConsentRequested && explicitAffirmative)) {
      conv.state.quoteConsentGiven = true;
    }

    // Track technical visit proposal flag
    if (parsed.propose_technical_visit) {
      conv.state.technicalVisitProposed = true;
    }

    // Generate & Attach Quote ONLY if consent has been given AND quote not yet sent
    const isQuoteNotYetSent = !conv.state.completedSteps.includes('QUOTE_SENT');

    if (conv.state.quoteConsentGiven && isQuoteNotYetSent && conv.state.monthlyBill) {
      const bill = conv.state.monthlyBill;
      const calcResult = this.quoteEngine.calculate(bill, (conv.state as any).extraLoads);

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

    // 6. Idempotent Media Dispatch (Anti-Spam)
    // Instalación Profesional (Step 2/3)
    const shouldSendInstalacion = (parsed.media_to_send === 'INSTALACION_PROFESIONAL' || parsed.next_step === 2 || parsed.next_step === 3) &&
                                  !conv.state.mediaSentFlags.instalacionProfessional;
    if (shouldSendInstalacion) {
      const imgUrl = `${AppConfig.mediaBaseUrl}/INSTALACION_PROFESIONAL.jpeg`;
      mediaSent.push(imgUrl);
      conv.state.mediaSentFlags.instalacionProfessional = true;

      // Refinamiento 1: Guardrail quirúrgico de frase puente en Paso 2
      const hasBridgePhrase = /(?:mientras|te comparto|informaci[oó]n detallada|nuestro servicio)/i.test(finalReply);
      if (!hasBridgePhrase) {
        finalReply = `${finalReply.trim()}\n\nMientras me pasas el dato, te comparto información detallada de nuestro servicio. 📄☀️`;
      }
    }

    // Financiamiento (Step 4/5)
    const shouldSendFinanciamiento = (parsed.media_to_send === 'FINANCIAMIENTO' || (conv.state.quoteConsentGiven && parsed.next_step >= 4)) &&
                                    !conv.state.mediaSentFlags.financiamiento;
    if (shouldSendFinanciamiento) {
      const imgUrl = `${AppConfig.mediaBaseUrl}/FINANCIAMIENTO.jpeg`;
      mediaSent.push(imgUrl);
      conv.state.mediaSentFlags.financiamiento = true;
    }

    // 7. Check Human Handoff trigger
    let isHandoff = parsed.trigger_human_handoff || parsed.propose_advisor_handoff;
    if (messageText.toLowerCase().includes('asesor') || messageText.toLowerCase().includes('humano') || messageText.toLowerCase().includes('agente')) {
      isHandoff = true;
    }

    if (isHandoff) {
      conv.botDisabled = true;
      conv.state.phase = 'HUMAN_HANDOFF';
      conv.state.advisorHandoffProposed = true;
      finalReply = `¡Con mucho gusto! En un momento uno de nuestros asesores especializados de O3 Energy se pondrá en contacto contigo directamente a través de este chat para brindarte atención personalizada. ☀️\n\n¡Que tengas un excelente día!`;

      // Save lead and alert sales team via email
      await this.triggerLeadHandoff(conv, phone, userName || conv.nombre, parsed.handoff_reason || 'Solicitud de cliente');
    } else {
      conv.state.phase = this.stepIntToPhase(parsed.next_step);
    }

    // Append messages to conversation history
    conv.messages.push({ sender: 'user', text: messageText, timestamp: new Date().toISOString() });
    conv.messages.push({ sender: 'bot', text: finalReply, timestamp: new Date().toISOString() });
    if (mediaSent.length > 0) {
      conv.messages.push({
        sender: 'bot',
        text: '📄 [Brochure Enviado]: Información detallada de servicios e instalación profesional',
        timestamp: new Date().toISOString(),
      });
    }
    conv.lastMessageAt = new Date().toISOString();

    // 8. Save state to repository (Persistent Database - Refinamiento 3)
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

      // ✅ Dual notification via AgentNotificationService (Email + WA Template HSM)
      const agentRepo = new AgentRepository(this.db);
      const notificationService = new AgentNotificationService(agentRepo);
      const agent = await notificationService.getAssignedAgent(conv.tenantId);

      const prospect: ProspectData = {
        nombre: name,
        phone,
        montoRecibo: `$${conv.state.monthlyBill || 0} MXN/mes`,
        sistemaEstimado: conv.state.roofType || 'Sistema Residencial',
        location: (conv.state as any).location,
        handoffReason: reason,
        conversationSummary: conv.messages.slice(-4).map((m: any) => `${m.sender}: ${m.text}`).join('\n'),
      };

      await notificationService.notify(agent, prospect, conv.tenantId);

      // Fallback legacy email check if notification service didn't send
      logger.info(`[SofiaFlowOrchestrator] Lead handoff completed for ${phone} (Assigned Agent: ${agent.name})`);
    } catch (err: any) {
      logger.error(`[SofiaFlowOrchestrator] Lead handoff failed:`, err);
      // Fallback to basic email notification
      try {
        await this.emailService.sendLeadNotification({
          leadName: name,
          phone,
          monthlyBill: conv.state.monthlyBill || 0,
          notes: `Solicitud de atención humana en WhatsApp: ${reason}`,
        });
      } catch (emailErr) {
        logger.error(`[SofiaFlowOrchestrator] Fallback email notification also failed:`, emailErr);
      }
    }
  }
}

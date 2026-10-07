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
import { BillNormalizerService, NormalizationResult } from '../../domain/services/BillNormalizerService.js';
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
  extractedBill?: {
    amount: number;
    frequency?: 'mensual' | 'bimestral';
    tariff?: string;
    receiptSource?: 'pdf' | 'image';
  };
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

    // Refinamiento 1: Sanitización Defensiva del pushname de WhatsApp (Regla 6: SSD & Regla 4: U-First)
    const isGenericPushname = /grupo|empresa|negocio|familia|casa|sertei|solar|oficina/i.test(userName || '');
    const safeUserName = isGenericPushname || !userName ? 'Cliente' : userName;
    conv.state.whatsappProfileName = userName;

    // Solo actualizar conv.nombre si es un nombre seguro no genérico Y conv.nombre era 'Cliente'
    // Si es genérico, conv.nombre permanece 'Cliente' obligando a preguntar el nombre humano
    if (conv.nombre === 'Cliente' && safeUserName !== 'Cliente') {
      (conv.state as any).suggestedName = safeUserName;
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
    if (input.extractedBill && input.extractedBill.amount > 0) {
      const extractedNorm = BillNormalizerService.normalize({
        rawAmount: input.extractedBill.amount,
        rawFrequency: input.extractedBill.frequency || 'bimestral',
        messageText: '',
      });
      if (extractedNorm) {
        conv.state.monthlyBill = extractedNorm.monthlyBill;
        conv.state.bimestralBill = extractedNorm.bimestralBill;
        conv.state.billFrequency = extractedNorm.frequency;
        (conv as any).montoRecibo = extractedNorm.formattedSummary;
        conv.state.equivalenceStated = true;
      }
      if (input.extractedBill.tariff) {
        (conv.state as any).tariff = input.extractedBill.tariff;
      }
    }

    const userMentionedBill = BillNormalizerService.preParseUserText(messageText);
    let preParsedBill: NormalizationResult | null = null;
    if (userMentionedBill) {
      preParsedBill = BillNormalizerService.normalize({
        rawAmount: userMentionedBill.amount,
        rawFrequency: userMentionedBill.frequency || conv.state.billFrequency,
        messageText,
      });

      if (preParsedBill) {
        conv.state.monthlyBill = preParsedBill.monthlyBill;
        conv.state.bimestralBill = preParsedBill.bimestralBill;
        conv.state.billFrequency = preParsedBill.frequency;
        (conv as any).montoRecibo = preParsedBill.formattedSummary;
        conv.state.equivalenceStated = true;
      }
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
        billAmount: conv.state.billFrequency === 'bimestral'
          ? (conv.state.bimestralBill || (conv.state.monthlyBill ? conv.state.monthlyBill * 2 : undefined))
          : conv.state.monthlyBill,
        billFrequency: conv.state.billFrequency,
        roofType: conv.state.roofType,
        hasShade: conv.state.hasShade,
        shadowsAssessed: conv.state.shadowsAssessed,
        equivalenceStated: conv.state.equivalenceStated,
        meterDistance: (conv.state as any).meterDistance,
        extraLoads: (conv.state as any).extraLoads,
        location: (conv.state as any).location,
        ownership: conv.state.isOwner ? 'Propio' : undefined,
      },
      calculatedQuote: calculatedQuoteInfo,
      quoteConsentRequested: conv.state.quoteConsentRequested,
      quoteConsentGiven: conv.state.quoteConsentGiven,
      financingConsentRequested: conv.state.financingConsentRequested,
      financingConsentGiven: conv.state.financingConsentGiven,
      botDisabled: conv.botDisabled,
      latestUserMessage: messageText,
      historySummary: conv.messages.slice(-6).map(m => `${m.sender}: ${m.text}`).join('\n'),
      isReturningContext,
      previousSessionSummary,
      mediaSentFlags: conv.state.mediaSentFlags,
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
          // Refinamiento 2: billChanged SOLO es true si el usuario aportó un dato numérico nuevo en messageText
          const billChanged = userMentionedBill !== null && conv.state.monthlyBill !== normalized.monthlyBill;

          // Solo actualizar montos si el usuario aportó un dato nuevo O si no teníamos montos previos
          if (userMentionedBill !== null || !conv.state.monthlyBill) {
            conv.state.monthlyBill = normalized.monthlyBill;
            conv.state.bimestralBill = normalized.bimestralBill;
            conv.state.billFrequency = normalized.frequency;
            (conv as any).montoRecibo = normalized.formattedSummary;
            conv.state.equivalenceStated = true;
          }

          // Dynamic Re-Quotation: If user corrected bill/frequency, clear QUOTE_SENT flag
          if (billChanged && conv.state.completedSteps.includes('QUOTE_SENT')) {
            conv.state.completedSteps = conv.state.completedSteps.filter(step => step !== 'QUOTE_SENT');
          }
        }
      }

      if (parsed.extracted_data.roof_type) {
        conv.state.roofType = parsed.extracted_data.roof_type;
      }
      if (parsed.extracted_data.shadows_status) {
        if (parsed.extracted_data.shadows_status === 'none') {
          conv.state.hasShade = false;
          conv.state.shadowsAssessed = true;
          conv.state.shadows_assessed = true;
        } else if (parsed.extracted_data.shadows_status === 'present') {
          conv.state.hasShade = true;
          conv.state.shadowsAssessed = true;
          conv.state.shadows_assessed = true;
        } else if (parsed.extracted_data.shadows_status === 'unknown') {
          if (conv.state.shadowsAssessed !== true) {
            conv.state.shadowsAssessed = false;
            conv.state.shadows_assessed = false;
          }
        }
      } else if (parsed.extracted_data.has_shade !== undefined && parsed.extracted_data.has_shade !== null) {
        conv.state.hasShade = Boolean(parsed.extracted_data.has_shade);
        conv.state.shadowsAssessed = true;
        conv.state.shadows_assessed = true;
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

    // Refinamiento 2: Completitud Técnica Dirigida por Estado (Sombras en Paso 3)
    let effectiveNextStep = parsed.next_step;
    if (conv.state.roofType && conv.state.shadowsAssessed !== true && effectiveNextStep >= 4) {
      effectiveNextStep = 3;
      const asksAboutShades = /(?:sombra|tinaco|árbol|arbol|edificio|muro|obstrucci[oó]n)/i.test(finalReply);
      if (!asksAboutShades) {
        finalReply = `¡Excelente, techo de ${conv.state.roofType}! 🏢 Y respecto a posibles sombras de árboles, tinacos o construcciones vecinas, ¿hay alguna que le dé a tu techo durante el día?`;
      }
    }

    // Generate & Attach Quote ONLY if consent has been given AND quote not yet sent AND step is at least 4
    const isQuoteNotYetSent = !conv.state.completedSteps.includes('QUOTE_SENT');

    if (conv.state.quoteConsentGiven && isQuoteNotYetSent && conv.state.monthlyBill && effectiveNextStep >= 4) {
      const bill = conv.state.monthlyBill;
      const calcResult = this.quoteEngine.calculate(bill, (conv.state as any).extraLoads);

      const quoteDto = {
        clientName: conv.nombre && conv.nombre !== 'Cliente' ? conv.nombre : ((conv.state as any).whatsappProfileName || 'Cliente'),
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
      
      // Desduplicación en Turno 4 (Anti-Redundancia): eliminar viñetas que repliquen la tarjeta oficial
      let cleanUserMsg = parsed.message_to_user
        .replace(/(?:[-*•]\s*)?\*?(?:Sistema|Costo estimado|Inversión estimada|Inversion estimada|Ahorro mensual|Ahorro anual|Retorno de inversión|Retorno de inversion)\*?:?.*(?:\r?\n|$)/gi, '')
        .trim();

      finalReply = cleanUserMsg ? `${pdfResult.textSummary}\n\n${cleanUserMsg}` : pdfResult.textSummary;
      conv.state.completedSteps.push('QUOTE_SENT');
    }

    // 6. Idempotent Media Dispatch (Anti-Spam)
    // Instalación Profesional (Step 2/3)
    const shouldSendInstalacion = (parsed.media_to_send === 'INSTALACION_PROFESIONAL' || effectiveNextStep === 2 || effectiveNextStep === 3) &&
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
    } else if (conv.state.mediaSentFlags.instalacionProfessional) {
      // Refinamiento 1 (APO-010): Sanitización precisa y segura si el brochure ya fue enviado previamente
      const bridgePhraseRegex = /\n*\s*Mientras me pasas el dato,?\s*te comparto información detallada de nuestro servicio\.?\s*📄☀️?\s*$/i;
      finalReply = finalReply.replace(bridgePhraseRegex, '').trim();

      // Fallback defensivo: si aún contiene la frase, forzar eliminación completa
      if (/mientras me pasas el dato.*te comparto información detallada/i.test(finalReply)) {
        finalReply = finalReply.replace(/mientras me pasas el dato.*?servicio\.?\s*📄☀️?/gi, '').trim();
      }
    }

    // Consent Gating Logic for Financing (Step 5) — Refinamiento 1 (APO-009)
    const wasFinancingRequested = conv.state.financingConsentRequested;
    if (parsed.financing_consent_requested || parsed.propose_financing) {
      conv.state.financingConsentRequested = true;
    }

    if (wasFinancingRequested && (explicitAffirmative || parsed.financing_consent_given)) {
      conv.state.financingConsentGiven = true;
    }

    // Guardrail de Defensa en Profundidad:
    // Si el mensaje saliente pregunta al usuario si desea el brochure/planes/requisitos,
    // significa que el bot está pidiendo permiso AHORA MISMO. El consentimiento NO puede estar dado.
    if (/(?:te gustar[ií]a|deseas|quieres|te env[ií]e|te comparto|gustas).*(?:brochure|requisitos|pasos|planes).*\??/i.test(finalReply)) {
      conv.state.financingConsentRequested = true;
      conv.state.financingConsentGiven = false; // Bloqueo determinista
    }

    // Financiamiento (Step 5) — Gating Estricto con Consentimiento (Primacía del Estado, Cero Spam)
    const shouldSendFinanciamiento =
      parsed.media_to_send === 'FINANCIAMIENTO' &&
      conv.state.financingConsentGiven === true &&
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
      conv.state.phase = this.stepIntToPhase(effectiveNextStep);
    }

    // Append messages to conversation history
    conv.messages.push({ sender: 'user', text: messageText, timestamp: new Date().toISOString() });
    conv.messages.push({ sender: 'bot', text: finalReply, timestamp: new Date().toISOString() });
    if (mediaSent.some(m => m.includes('INSTALACION_PROFESIONAL'))) {
      conv.messages.push({
        sender: 'bot',
        text: '📄 [Brochure Enviado]: Información detallada de servicios e instalación profesional',
        timestamp: new Date().toISOString(),
      });
    }
    if (mediaSent.some(m => m.includes('FINANCIAMIENTO'))) {
      conv.messages.push({
        sender: 'bot',
        text: '📄 [Brochure Enviado]: Planes y requisitos de financiamiento solar',
        timestamp: new Date().toISOString(),
      });
    }
    conv.lastMessageAt = new Date().toISOString();

    // 8. Save state to repository (Persistent Database - Refinamiento 3)
    await this.conversationRepo.save(conv);

    return {
      replyText: finalReply,
      nextStep: effectiveNextStep,
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

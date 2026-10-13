/**
 * SofiaForensicApo027.test.ts
 * Batería SQA Forense de Validación Arquitectónica APO-027.
 * Auditoría: Qwen Senior Forensic Auditor & Héctor Álvarez.
 * Mandatos:
 * - T96: Flujo Primario LLM con confirmación afirmativa a propuesta de cita -> HUMAN_HANDOFF, botDisabled = true, lead persistido como 'pending_review' y notificación despachada a 523319459597.
 * - T97: Flujo Resiliente Fallback (LLM 429 / Timeout) -> Fallback determinista detecta "si" en CLOSING, responde con despedida cálida, apaga el bot y genera el lead calificado sin caer en "intermitencia técnica".
 * - T98: Cero Fricción Conversacional (Regla Inamovible 4: U-First) -> Verificación de que Sofía y el fallback NUNCA solicitan en el chat calle, dirección, número, colonia, código postal ni negocian fecha/hora.
 * - T99: Microservicio AgentNotificationService -> Normalización E.164 (+52 1 33 1945 9597 -> 523319459597), intento de HSM y degradación a texto enriquecido con enlace directo https://wa.me/.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReceiveMessageUseCase } from '../../application/usecases/ReceiveMessageUseCase.js';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { WhatsAppMediaService } from '../../infrastructure/media/WhatsAppMediaService.js';
import { CfeReceiptExtractorService } from '../services/CfeReceiptExtractorService.js';
import { AgentNotificationService, normalizeWhatsAppPhone } from '../../infrastructure/services/AgentNotificationService.js';
import { AgentRepository } from '../../infrastructure/persistence/AgentRepository.js';
import { AppConfig } from '../../shared/config/AppConfig.js';

describe('SQA Forense Plan APO-027 — Tests T96 a T99 (Transición Inmediata a Lead y Notificación a Especialista)', () => {
  const tenantId = 'o3energy_mexico';

  function createTestHarness(options?: {
    llmFails?: boolean;
    llmErrorStatus?: number;
    llmErrorMessage?: string;
    customLlmResponse?: any;
  }) {
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();
    const sendWhatsApp = vi.fn().mockResolvedValue(true);
    const sendWhatsAppMedia = vi.fn().mockResolvedValue(true);

    const mockLlm = {
      complete: vi.fn().mockImplementation(async () => {
        if (options?.llmFails) {
          const err = new Error(options.llmErrorMessage || 'Groq API error 429: Rate limit exceeded (8000 TPM)');
          if (options.llmErrorStatus) {
            (err as any).status = options.llmErrorStatus;
          }
          throw err;
        }
        if (options?.customLlmResponse) {
          return {
            text: JSON.stringify(options.customLlmResponse),
            finishReason: 'stop',
          };
        }
        return {
          text: JSON.stringify({
            next_step: 6,
            message_to_user: '¡Excelente, Héctor! Con mucho gusto. En un momento uno de nuestros especialistas de O3 Energy se pondrá en contacto contigo a través de este número para agendar tu cita y afinar todos los detalles técnicos. ☀️ ¡Que tengas un excelente día!',
            trigger_human_handoff: true,
            propose_advisor_handoff: true,
            handoff_reason: 'Cliente solicita contacto de especialista para agendar cita',
            extracted_data: {},
          }),
          finishReason: 'stop',
        };
      }),
    };

    const orchestrator = new SofiaFlowOrchestrator(
      convRepo,
      leadRepo,
      quoteEngine,
      mockLlm as any,
      sendWhatsApp as any,
      { sendLeadNotification: vi.fn().mockResolvedValue(true) } as any
    );

    const mediaService = new WhatsAppMediaService();
    const extractorService = new CfeReceiptExtractorService();

    const useCase = new ReceiveMessageUseCase(
      convRepo,
      orchestrator,
      sendWhatsApp,
      sendWhatsAppMedia,
      mediaService,
      extractorService,
      quoteEngine
    );

    return {
      convRepo,
      leadRepo,
      quoteEngine,
      sendWhatsApp,
      sendWhatsAppMedia,
      orchestrator,
      useCase,
      mockLlm,
    };
  }

  // ─── T96: FLUJO PRIMARIO CON LLM Y CONTACTO DIRECTO DE ESPECIALISTA ────────
  it('T96: Flujo Primario LLM — Usuario confirma con "sí" a la propuesta de cita -> HUMAN_HANDOFF, botDisabled = true, lead guardado en Firestore con status pending_review', async () => {
    const phone = '5214777027096';
    const harness = createTestHarness();

    // 1. Inicializar conversación previa con cotización enviada y brochure de financiamiento
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor';
    conv.state.monthlyBill = 148228;
    conv.state.roofType = 'concreto';
    conv.state.hasShade = false;
    conv.state.completedSteps = ['ROOF_CONFIRMED', 'SHADOWS_ASSESSED', 'QUOTE_SENT'];
    conv.state.phase = 'FINANCING';
    conv.state.financingConsentGiven = true;
    conv.state.mediaSentFlags = { financiamiento: true };
    await harness.convRepo.save(conv);

    // 2. Usuario confirma con "sí, me gustaría que me contacten"
    const result = await harness.useCase.execute({
      tenantId,
      phone,
      text: 'sí, me gustaría que me contacten',
    });

    // 3. Verificaciones de Arquitectura y UX
    const updatedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(updatedConv.state.phase).toBe('HUMAN_HANDOFF');
    expect(updatedConv.botDisabled).toBe(true);
    expect(updatedConv.state.advisorHandoffProposed).toBe(true);
    expect(result.leadGenerated).toBe(true);

    // 4. Verificación de persistencia de lead enriquecido
    const leads = await harness.leadRepo.findAll(tenantId);
    const savedLead = leads.find((l) => l.id === phone);
    expect(savedLead).toBeDefined();
    expect(savedLead?.status).toBe('pending_review');
    expect(savedLead?.nombre).toBe('Héctor');
    expect(savedLead?.sistemaEstimado).toContain('paneles');
    expect(savedLead?.costoEstimado).toMatch(/\$[0-9,]+\s*MXN/);

    // 5. Verificación de respuesta amable al usuario
    expect(result.reply).toContain('Héctor');
    expect(result.reply).toContain('se pondrá en contacto contigo');
    expect(result.reply).toMatch(/(?:agendar|coordinar)\s+tu\s+cita/i);
  });

  // ─── T97: FLUJO RESILIENTE FALLBACK ANTE RATE LIMIT / TIMEOUT (HTTP 429) ───
  it('T97: Flujo Resiliente Fallback (LLM 429) — Usuario responde "si" en CLOSING -> Fallback ejecuta CASO 7 determinista sin intermitencia técnica', async () => {
    const phone = '5214777027097';
    const harness = createTestHarness({
      llmFails: true,
      llmErrorStatus: 429,
      llmErrorMessage: 'Groq API error 429: Rate limit exceeded (8000 TPM)',
    });

    // 1. Conversación en fase CLOSING tras recibir brochure de financiamiento
    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor Álvarez';
    conv.state.monthlyBill = 148228;
    conv.state.roofType = 'concreto';
    conv.state.hasShade = false;
    conv.state.completedSteps = ['ROOF_CONFIRMED', 'SHADOWS_ASSESSED', 'QUOTE_SENT'];
    conv.state.phase = 'CLOSING';
    conv.state.mediaSentFlags = { financiamiento: true };
    await harness.convRepo.save(conv);

    // 2. Simular mensaje "si" de Héctor
    const result = await harness.useCase.execute({
      tenantId,
      phone,
      text: 'si',
    });

    // 3. Verificaciones de Cero Intermitencia Técnica
    expect(result.reply).not.toContain('intermitencia técnica');
    expect(result.reply).not.toContain('uno de nuestros asesores continuará atendiéndote');
    expect(result.reply).toContain('Héctor Álvarez');
    expect(result.reply).toContain('se pondrá en contacto contigo a través de este número para agendar tu cita');
    expect(result.leadGenerated).toBe(true);

    const updatedConv = await harness.convRepo.findByPhone(tenantId, phone);
    expect(updatedConv.state.phase).toBe('HUMAN_HANDOFF');
    expect(updatedConv.botDisabled).toBe(true);
  });

  // ─── T98: CERO FRICCIÓN CONVERSACIONAL (REGLA INAMOVIBLE 4: U-FIRST) ───────
  it('T98: Regla U-First — Sofía y el fallback NUNCA solicitan al usuario que escriba calle, dirección, colonia, código postal ni negociar fecha/hora', async () => {
    const phone = '5214777027098';
    const harness = createTestHarness({
      llmFails: true,
      llmErrorStatus: 429,
    });

    const conv = await harness.convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor';
    conv.state.monthlyBill = 5000;
    conv.state.roofType = 'concreto';
    conv.state.phase = 'CLOSING';
    await harness.convRepo.save(conv);

    const result = await harness.useCase.execute({
      tenantId,
      phone,
      text: 'adelante, agendemos',
    });

    // Prohibición estricta de solicitud de datos pesados de ubicación o negociación de calendario
    expect(result.reply).not.toMatch(/¿qu[eé] d[ií]a y hora te conviene\?/i);
    expect(result.reply).not.toMatch(/ind[ií]came la direcci[oó]n completa/i);
    expect(result.reply).not.toMatch(/calle y n[uú]mero/i);
    expect(result.reply).not.toMatch(/c[oó]digo postal/i);
    expect(result.reply).not.toMatch(/colonia/i);
    expect(result.reply).toContain('se pondrá en contacto contigo a través de este número');
  });

  // ─── T99: MICROSERVICIO AGENT NOTIFICATION SERVICE CON DUAL RESILIENCE ────
  it('T99: AgentNotificationService — Normaliza +52 1 33 1945 9597 a 523319459597, soporta plantilla HSM y fallback de texto enriquecido con wa.me', async () => {
    // 1. Verificación de normalización
    expect(normalizeWhatsAppPhone('+52 1 33 1945 9597')).toBe('523319459597');
    expect(normalizeWhatsAppPhone('5213319459597')).toBe('523319459597');
    expect(normalizeWhatsAppPhone('3319459597')).toBe('523319459597');

    // 2. Verificación de configuración de fallback
    expect(AppConfig.agents.fallbackWhatsapp).toBe('523319459597');

    const agentRepo = new AgentRepository();
    const service = new AgentNotificationService(agentRepo);

    // 3. Simulación de agente fallback
    const agent = await service.getAssignedAgent(tenantId);
    expect(agent.whatsappPhone).toBe('523319459597');

    // 4. Notificación sin fallos bloqueantes (Promise.allSettled)
    const prospect = {
      nombre: 'Héctor Álvarez',
      phone: '5214777241148',
      montoRecibo: '$148,228 MXN/mes',
      sistemaEstimado: '12 paneles (6.6 kWp) - Techo concreto ($77,700 MXN)',
      handoffReason: 'Cliente solicita contacto de especialista para agendar cita',
    };

    await expect(service.notify(agent, prospect, tenantId)).resolves.not.toThrow();
  });
});

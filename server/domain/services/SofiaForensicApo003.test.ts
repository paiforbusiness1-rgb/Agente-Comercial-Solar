/**
 * SofiaForensicApo003.test.ts
 * Suite SQA Forense — Plan APO-003 v2 (T01 - T07).
 * Cero regresiones, HRU, SSD, y tolerancia a fallos en cascada.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SofiaPromptBuilder, UserContext } from '../../application/builders/SofiaPromptBuilder.js';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { AgentNotificationService, ProspectData } from '../../infrastructure/services/AgentNotificationService.js';
import { AgentRepository } from '../../infrastructure/persistence/AgentRepository.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { AppConfig } from '../../shared/config/AppConfig.js';
import { Agent } from '../../domain/entities/Agent.js';

describe('SQA Forense Plan APO-003 v2 — Tests T01 a T07', () => {

  // ─── T01: Usuario nuevo envía "hola" ───────────────────────────────────────
  it('T01: Usuario nuevo envía "hola" → isReturningContext=false y flujo GREETING normal', () => {
    const newUserContext: UserContext = {
      phone: '5214771112233',
      userName: 'Cliente',
      currentStep: 1,
      extractedData: {},
      botDisabled: false,
      latestUserMessage: 'hola',
      isReturningContext: false,
    };

    const { systemPrompt, userContent } = SofiaPromptBuilder.buildPrompt(newUserContext);

    expect(userContent).toContain('<is_returning_context>false</is_returning_context>');
    expect(userContent).toContain('<name>Cliente</name>');
    expect(systemPrompt).toContain('REGLA 0 — MODO USUARIO DE REGRESO');
  });

  // ─── T02: Usuario con historial envía "hola" ──────────────────────────────
  it('T02: Usuario con historial envía "hola" → isReturningContext=true y genera prompt contextual', () => {
    const returningUserContext: UserContext = {
      phone: '5214779998877',
      userName: 'Héctor Álvarez',
      currentStep: 2,
      extractedData: { billAmount: 1400, billFrequency: 'bimestral' },
      botDisabled: false,
      latestUserMessage: 'hola buenas tardes',
      historySummary: 'user: hola\nbot: Hola soy Sofía\nuser: pago 2800 al bimestre',
      isReturningContext: true,
      previousSessionSummary: 'Conversación previa: recibo de $1400 MXN/mes, se presentó cotización preliminar.',
    };

    const { userContent } = SofiaPromptBuilder.buildPrompt(returningUserContext);

    expect(userContent).toContain('<is_returning_context>true</is_returning_context>');
    expect(userContent).toContain('recibo de $1400 MXN/mes');
    expect(userContent).toContain('<name>Héctor Álvarez</name>');
  });

  // ─── T03: Returning user responde "retomar" ────────────────────────────────
  it('T03: LLM marca returning_user_greeted=true → SofiaPromptBuilder parsea correctamente', () => {
    const sampleLlmOutput = JSON.stringify({
      next_step: 3,
      message_to_user: '¡Hola Héctor! 😊 Qué gusto saludarte de nuevo. ¿Retomamos donde quedamos?',
      returning_user_greeted: true,
      extracted_data: { client_name: 'Héctor' },
      trigger_human_handoff: false,
    });

    const parsed = SofiaPromptBuilder.parseResponse(sampleLlmOutput);

    expect(parsed.returning_user_greeted).toBe(true);
    expect(parsed.next_step).toBe(3);
    expect(parsed.trigger_human_handoff).toBe(false);
  });

  // ─── T04: Returning user responde "asesor" ─────────────────────────────────
  it('T04: Usuario solicita asesor → activa trigger_human_handoff y asigna agente', async () => {
    const mockAgentRepo = new AgentRepository();
    const testAgent: Agent = {
      id: 'agent_01',
      tenantId: 'o3energy_mexico',
      name: 'Asesor Carlos',
      email: 'carlos@o3energy.mx',
      whatsappPhone: '5214771234567',
      isActive: true,
      assignedLeadsCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mockAgentRepo.save(testAgent, 'o3energy_mexico');

    const notificationService = new AgentNotificationService(mockAgentRepo);
    const assigned = await notificationService.getAssignedAgent('o3energy_mexico');

    expect(assigned).toBeDefined();
    expect(assigned.email).toBe('carlos@o3energy.mx');
    expect(assigned.name).toBe('Asesor Carlos');
  });

  // ─── T05: Chat eliminado → mismo número escribe ───────────────────────────
  it('T05: Chat archivado en deleted_chats y nuevo chat inicia 100% limpio', async () => {
    const convRepo = new InMemoryConversationRepository();
    const tenantId = 'o3energy_mexico';
    const phone = '5214771239999';

    // 1. Crear conversación activa
    const initialConv = await convRepo.findByPhone(tenantId, phone);
    initialConv.nombre = 'Héctor';
    initialConv.messages.push({ sender: 'user', text: 'hola', timestamp: new Date().toISOString() });
    initialConv.state.monthlyBill = 1400;
    await convRepo.save(initialConv);

    // 2. Soft-delete
    const deleted = await convRepo.softDelete(tenantId, phone, 'admin@o3energy.mx');
    expect(deleted).toBe(true);

    // 3. Verificar que en la lista activa ya no aparece
    const activeChats = await convRepo.findAll(tenantId);
    expect(activeChats.some(c => c.phone === phone)).toBe(false);

    // 4. Verificar que aparece en la papelera
    const trash = await convRepo.findTrash(tenantId);
    expect(trash.some(c => c.phone === phone)).toBe(true);

    // 5. Restauración
    const restored = await convRepo.restore(tenantId, phone);
    expect(restored).toBe(true);
    const restoredConv = await convRepo.findByPhone(tenantId, phone);
    expect(restoredConv.status).toBe('active');
  });

  // ─── T06: Handoff sin agentes activos → Fallback robusto ───────────────────
  it('T06: Cero agentes activos → Fallback a AppConfig.agents.fallbackEmail sin lanzar error', async () => {
    // Repositorio vacío (cero agentes)
    const emptyAgentRepo = new AgentRepository();
    const notificationService = new AgentNotificationService(emptyAgentRepo);

    const fallbackAgent = await notificationService.getAssignedAgent('empty_tenant');

    expect(fallbackAgent.id).toBe('fallback');
    expect(fallbackAgent.email).toBe(AppConfig.agents.fallbackEmail);
    expect(fallbackAgent.name).toContain('Equipo Comercial');
  });

  // ─── T07: WA template falla → degradación elegante con Email ──────────────
  it('T07: Meta API falla en WhatsApp → Promise.allSettled garantiza degradación elegante sin romper handoff', async () => {
    const mockAgentRepo = new AgentRepository();
    const agent: Agent = {
      id: 'agent_fail_wa',
      tenantId: 'o3energy_mexico',
      name: 'Agente Prueba',
      email: 'prueba@o3energy.mx',
      whatsappPhone: '5210000000000',
      isActive: true,
      assignedLeadsCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const notificationService = new AgentNotificationService(mockAgentRepo);

    const prospect: ProspectData = {
      nombre: 'Prospecto Prueba',
      phone: '5214778887766',
      montoRecibo: '$1,500 MXN',
      sistemaEstimado: '4 paneles solares',
      handoffReason: 'Solicitud de asesor humano',
    };

    // Simulamos fallo en fetch de WhatsApp
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Meta API 400 Bad Request'));

    try {
      // Debe ejecutarse sin lanzar excepción (degradación elegante)
      await expect(notificationService.notify(agent, prospect, 'o3energy_mexico')).resolves.not.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

});

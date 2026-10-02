/**
 * AgentRepository.test.ts
 * SQA Suite for AgentRepository (APO-005 Mandato Forense)
 * Validates Firestore odd-segment collection paths, CRUD operations,
 * round-robin least-loaded ordering, and AgentNotificationService integration.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentRepository } from './AgentRepository.js';
import { AgentNotificationService } from '../services/AgentNotificationService.js';

describe('AgentRepository — Firestore Persistence & Round-Robin SQA Suite (APO-005)', () => {
  const tenantId = 'test_tenant_solar';

  // ─── T08: Validación de Ruta Impar de Firestore (Regla NoSQL de Google Cloud) ─────
  it('T08: Valida que la ruta de la colección en Firestore tiene un número impar de componentes (tenants/{tenantId}/agents)', async () => {
    let capturedPath = '';
    const mockDb = {
      collection: vi.fn((path: string) => {
        capturedPath = path;
        const segments = path.split('/').filter(Boolean);
        if (segments.length % 2 === 0) {
          throw new Error(
            `Value for argument "collectionPath" must point to a collection, but was "${path}". Your path does not contain an odd number of components.`
          );
        }
        return {
          orderBy: vi.fn().mockReturnThis(),
          get: vi.fn().mockResolvedValue({ docs: [] }),
        };
      }),
    };

    const repo = new AgentRepository(mockDb);
    await repo.findAll(tenantId);

    expect(capturedPath).toBe(`tenants/${tenantId}/agents`);
    const segments = capturedPath.split('/').filter(Boolean);
    expect(segments.length).toBe(3);
    expect(segments.length % 2).toBe(1); // Impar garantizado
  });

  // ─── T09: Guardado y Creación (save) ─────────────────────────────────────
  it('T09: save() crea un nuevo agente con ID, timestamps y valores por defecto', async () => {
    const repo = new AgentRepository();
    const newAgent = await repo.save({
      name: 'Hector Alvarez',
      email: 'halvareznet@gmail.com',
      whatsappPhone: '5214773975020',
      tenantId,
    }, tenantId);

    expect(newAgent.id).toBeDefined();
    expect(newAgent.name).toBe('Hector Alvarez');
    expect(newAgent.email).toBe('halvareznet@gmail.com');
    expect(newAgent.whatsappPhone).toBe('5214773975020');
    expect(newAgent.assignedLeadsCount).toBe(0);
    expect(newAgent.isActive).toBe(true);
    expect(newAgent.createdAt).toBeDefined();
    expect(newAgent.updatedAt).toBeDefined();
  });

  // ─── T10: Actualización (update) ─────────────────────────────────────────
  it('T10: save() actualiza un agente existente preservando su ID y createdAt', async () => {
    const repo = new AgentRepository();
    const created = await repo.save({
      name: 'Carlos Ruiz',
      email: 'carlos@o3energy.mx',
      whatsappPhone: '5215512345678',
      tenantId,
    }, tenantId);

    const updated = await repo.save({
      id: created.id,
      name: 'Carlos Ruiz Modificado',
      email: 'carlos.modificado@o3energy.mx',
      whatsappPhone: '5215587654321',
      tenantId,
    }, tenantId);

    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('Carlos Ruiz Modificado');
    expect(updated.email).toBe('carlos.modificado@o3energy.mx');
    expect(updated.createdAt).toBe(created.createdAt);
  });

  // ─── T11: Búsqueda (findAll & findById) ───────────────────────────────────
  it('T11: findAll() y findById() recuperan los agentes correspondientes', async () => {
    const repo = new AgentRepository();
    const a1 = await repo.save({ name: 'Agente 1', email: 'a1@o3energy.mx', whatsappPhone: '5210000000001', tenantId }, tenantId);
    const a2 = await repo.save({ name: 'Agente 2', email: 'a2@o3energy.mx', whatsappPhone: '5210000000002', tenantId }, tenantId);

    const all = await repo.findAll(tenantId);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.some(a => a.id === a1.id)).toBe(true);
    expect(all.some(a => a.id === a2.id)).toBe(true);

    const found = await repo.findById(tenantId, a1.id);
    expect(found).not.toBeNull();
    expect(found?.email).toBe('a1@o3energy.mx');

    const notFound = await repo.findById(tenantId, 'non_existent_id');
    expect(notFound).toBeNull();
  });

  // ─── T12: Round-Robin y Asignación por Menor Carga (Least-Loaded) ─────────
  it('T12: findActiveAgents() filtra inactivos y ordena por assignedLeadsCount ascendente', async () => {
    const repo = new AgentRepository();
    const tId = `round_robin_tenant_${Date.now()}`;

    // Agente 1: Carga 5
    const a1 = await repo.save({ name: 'Agente Ocupado', email: 'ocupado@o3energy.mx', whatsappPhone: '5211111111111', assignedLeadsCount: 5, isActive: true, tenantId: tId }, tId);
    // Agente 2: Carga 1
    const a2 = await repo.save({ name: 'Agente Disponible', email: 'disponible@o3energy.mx', whatsappPhone: '5212222222222', assignedLeadsCount: 1, isActive: true, tenantId: tId }, tId);
    // Agente 3: Inactivo con Carga 0
    await repo.save({ name: 'Agente Inactivo', email: 'inactivo@o3energy.mx', whatsappPhone: '5213333333333', assignedLeadsCount: 0, isActive: false, tenantId: tId }, tId);

    const activeAgents = await repo.findActiveAgents(tId);
    expect(activeAgents.length).toBe(2);
    expect(activeAgents[0].id).toBe(a2.id); // El de menor carga (1 lead)
    expect(activeAgents[1].id).toBe(a1.id); // El de mayor carga (5 leads)

    // Servicio de notificación asigna al primero (menor carga)
    const notificationService = new AgentNotificationService(repo);
    const assigned = await notificationService.getAssignedAgent(tId);
    expect(assigned.id).toBe(a2.id);
  });

  // ─── T13: Incremento de Leads Asignados ────────────────────────────────────
  it('T13: incrementLeadCount() incrementa el contador de leads asignados', async () => {
    const repo = new AgentRepository();
    const tId = `inc_tenant_${Date.now()}`;
    const agent = await repo.save({ name: 'Agente Contador', email: 'contador@o3energy.mx', whatsappPhone: '5214444444444', assignedLeadsCount: 2, tenantId: tId }, tId);

    await repo.incrementLeadCount(tId, agent.id);
    const afterInc = await repo.findById(tId, agent.id);
    expect(afterInc?.assignedLeadsCount).toBe(3);
  });

  // ─── T14: Desactivación y Eliminación (deactivate & delete) ───────────────
  it('T14: deactivate() y delete() modifican el estado y eliminan del repositorio', async () => {
    const repo = new AgentRepository();
    const tId = `del_tenant_${Date.now()}`;
    const agent = await repo.save({ name: 'Agente Borrable', email: 'borrable@o3energy.mx', whatsappPhone: '5215555555555', tenantId: tId }, tId);

    // Desactivar
    const deactivated = await repo.deactivate(tId, agent.id);
    expect(deactivated).toBe(true);
    const afterDeact = await repo.findById(tId, agent.id);
    expect(afterDeact?.isActive).toBe(false);

    // Eliminar
    const deleted = await repo.delete(tId, agent.id);
    expect(deleted).toBe(true);
    const afterDel = await repo.findById(tId, agent.id);
    expect(afterDel).toBeNull();
  });
});

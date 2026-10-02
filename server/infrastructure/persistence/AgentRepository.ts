/**
 * AgentRepository.ts
 * Firestore persistence for Agent entities with In-Memory fallback.
 * Collection: tenants/{tenantId}/agents (3 components - Odd number required by Firestore)
 * Implements round-robin assignment by assignedLeadsCount (Anti-God-Object Rule 3).
 */

import { Agent } from '../../domain/entities/Agent.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';

// In-Memory store fallback for environments without Firestore (tests, offline dev)
const inMemoryAgentsStore: Record<string, Record<string, Agent>> = {};

export class AgentRepository {
  constructor(private db?: any) {}

  private col(tenantId: string) {
    if (this.db) {
      return this.db.collection(`tenants/${tenantId}/agents`);
    }
    return null;
  }

  private getTenantStore(tenantId: string): Record<string, Agent> {
    if (!inMemoryAgentsStore[tenantId]) {
      inMemoryAgentsStore[tenantId] = {};
    }
    return inMemoryAgentsStore[tenantId];
  }

  async findAll(tenantId: string): Promise<Agent[]> {
    const colRef = this.col(tenantId);
    if (colRef) {
      try {
        const snap = await colRef.orderBy('createdAt', 'asc').get();
        return snap.docs.map((d: any) => ({ id: d.id, ...d.data() } as Agent));
      } catch (err: any) {
        logger.warn('[AgentRepo] Fallback to In-Memory for findAll', { error: err.message });
      }
    }
    const store = this.getTenantStore(tenantId);
    return Object.values(store).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async findById(tenantId: string, agentId: string): Promise<Agent | null> {
    const colRef = this.col(tenantId);
    if (colRef) {
      try {
        const doc = await colRef.doc(agentId).get();
        if (!doc.exists) return null;
        return { id: doc.id, ...doc.data() } as Agent;
      } catch (err: any) {
        logger.warn('[AgentRepo] Fallback to In-Memory for findById', { error: err.message });
      }
    }
    const store = this.getTenantStore(tenantId);
    return store[agentId] || null;
  }

  async findActiveAgents(tenantId: string): Promise<Agent[]> {
    const colRef = this.col(tenantId);
    if (colRef) {
      try {
        const snap = await colRef
          .where('isActive', '==', true)
          .orderBy('assignedLeadsCount', 'asc')
          .get();
        return snap.docs.map((d: any) => ({ id: d.id, ...d.data() } as Agent));
      } catch (err: any) {
        logger.warn('[AgentRepo] Fallback to In-Memory for findActiveAgents', { error: err.message });
      }
    }
    const store = this.getTenantStore(tenantId);
    return Object.values(store)
      .filter((a) => a.isActive)
      .sort((a, b) => a.assignedLeadsCount - b.assignedLeadsCount);
  }

  async save(
    agent: Omit<Agent, 'id' | 'createdAt' | 'updatedAt' | 'isActive' | 'assignedLeadsCount'> & {
      id?: string;
      createdAt?: string;
      updatedAt?: string;
      isActive?: boolean;
      assignedLeadsCount?: number;
    },
    tenantId: string
  ): Promise<Agent> {
    const now = new Date().toISOString();
    const store = this.getTenantStore(tenantId);

    if (agent.id) {
      const colRef = this.col(tenantId);
      if (colRef) {
        try {
          const ref = colRef.doc(agent.id);
          await ref.set({ ...agent, updatedAt: now }, { merge: true });
        } catch (err: any) {
          logger.warn('[AgentRepo] Fallback to In-Memory for save update', { error: err.message });
        }
      }
      const existing = store[agent.id] || {};
      const updated: Agent = {
        ...existing,
        ...agent,
        id: agent.id,
        tenantId,
        updatedAt: now,
      } as Agent;
      store[agent.id] = updated;
      return updated;
    }

    const colRef = this.col(tenantId);
    const newId = colRef ? colRef.doc().id : `agent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const newAgent: Agent = {
      ...agent,
      id: newId,
      tenantId,
      assignedLeadsCount: agent.assignedLeadsCount ?? 0,
      isActive: agent.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    };

    if (colRef) {
      try {
        await colRef.doc(newId).set(newAgent);
      } catch (err: any) {
        logger.warn('[AgentRepo] Fallback to In-Memory for save create', { error: err.message });
      }
    }

    store[newId] = newAgent;
    return newAgent;
  }

  async deactivate(tenantId: string, agentId: string): Promise<boolean> {
    const colRef = this.col(tenantId);
    if (colRef) {
      try {
        const ref = colRef.doc(agentId);
        const doc = await ref.get();
        if (doc.exists) {
          await ref.update({ isActive: false, updatedAt: new Date().toISOString() });
        }
      } catch (err: any) {
        logger.warn('[AgentRepo] Fallback to In-Memory for deactivate', { error: err.message });
      }
    }
    const store = this.getTenantStore(tenantId);
    if (store[agentId]) {
      store[agentId].isActive = false;
      store[agentId].updatedAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  async incrementLeadCount(tenantId: string, agentId: string): Promise<void> {
    const colRef = this.col(tenantId);
    if (colRef) {
      try {
        const ref = colRef.doc(agentId);
        const snap = await ref.get();
        if (snap.exists) {
          const current = snap.data()?.assignedLeadsCount || 0;
          await ref.update({
            assignedLeadsCount: current + 1,
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (err: any) {
        logger.warn('[AgentRepo] Fallback to In-Memory for incrementLeadCount', { error: err.message });
      }
    }
    const store = this.getTenantStore(tenantId);
    if (store[agentId]) {
      store[agentId].assignedLeadsCount = (store[agentId].assignedLeadsCount || 0) + 1;
      store[agentId].updatedAt = new Date().toISOString();
    }
  }

  async delete(tenantId: string, agentId: string): Promise<boolean> {
    const colRef = this.col(tenantId);
    let firestoreDeleted = false;
    if (colRef) {
      try {
        const ref = colRef.doc(agentId);
        const doc = await ref.get();
        if (doc.exists) {
          await ref.delete();
          firestoreDeleted = true;
        }
      } catch (err: any) {
        logger.warn('[AgentRepo] Fallback to In-Memory for delete', { error: err.message });
      }
    }
    const store = this.getTenantStore(tenantId);
    if (store[agentId]) {
      delete store[agentId];
      return true;
    }
    return firestoreDeleted;
  }
}

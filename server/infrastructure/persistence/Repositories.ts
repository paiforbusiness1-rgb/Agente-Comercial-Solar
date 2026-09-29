import { IConversationRepository } from '../../domain/repositories/IConversationRepository.js';
import { ILeadRepository } from '../../domain/repositories/ILeadRepository.js';
import { Conversation, ConversationState, Message } from '../../domain/entities/Conversation.js';
import { Lead } from '../../domain/entities/Lead.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';

// ─── In-Memory Fallback (replaces old inMemoryChats/inMemoryLeads) ────────

const chatsStore: Record<string, Conversation> = {};
const leadsStore: Record<string, Lead> = {};

const defaultState = (): ConversationState => ({
  phase: 'GREETING',
  completedSteps: [],
  missingFields: ['name', 'isOwner', 'monthlyBill'],
  leadScore: 0,
});

export class InMemoryConversationRepository implements IConversationRepository {
  async findByPhone(tenantId: string, phone: string): Promise<Conversation> {
    const key = `${tenantId}::${phone}`;
    if (!chatsStore[key]) {
      chatsStore[key] = {
        id: phone, tenantId, phone, nombre: 'Cliente',
        botDisabled: false, messages: [], state: defaultState(),
        lastMessageAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
    }
    return chatsStore[key];
  }

  async save(conversation: Conversation): Promise<void> {
    const key = `${conversation.tenantId}::${conversation.phone}`;
    chatsStore[key] = conversation;
  }

  async findAll(tenantId: string): Promise<Conversation[]> {
    return Object.values(chatsStore).filter((c) => c.tenantId === tenantId);
  }
}

export class InMemoryLeadRepository implements ILeadRepository {
  async save(lead: Lead): Promise<void> {
    leadsStore[lead.id] = lead;
  }

  async findAll(tenantId: string): Promise<Lead[]> {
    return Object.values(leadsStore).filter((l) => l.tenantId === tenantId);
  }

  async updateStatus(tenantId: string, leadId: string, status: Lead['status']): Promise<void> {
    if (leadsStore[leadId]) leadsStore[leadId].status = status;
  }

  async updateNotes(tenantId: string, leadId: string, notes: string): Promise<void> {
    if (leadsStore[leadId]) leadsStore[leadId].privateNotes = notes;
  }
}

// ─── Firestore Repositories ───────────────────────────────────────────────

const inMemoryConvFallback = new InMemoryConversationRepository();
const inMemoryLeadFallback = new InMemoryLeadRepository();

export class FirestoreConversationRepository implements IConversationRepository {
  constructor(private db: any) {}

  async findByPhone(tenantId: string, phone: string): Promise<Conversation> {
    try {
      const docRef = this.db.collection(`tenants/${tenantId}/chats`).doc(phone);
      const doc = await docRef.get();
      if (!doc.exists) {
        const conv: Conversation = {
          id: phone, tenantId, phone, nombre: 'Cliente',
          botDisabled: false, messages: [], state: defaultState(),
          lastMessageAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };
        await docRef.set(conv);
        return conv;
      }
      return { id: doc.id, ...doc.data() } as Conversation;
    } catch (err: any) {
      logger.warn('[FirestoreConversationRepo] Fallback to In-Memory due to Firestore error', { error: err.message });
      return inMemoryConvFallback.findByPhone(tenantId, phone);
    }
  }

  async save(conversation: Conversation): Promise<void> {
    await inMemoryConvFallback.save(conversation);
    try {
      await this.db
        .collection(`tenants/${conversation.tenantId}/chats`)
        .doc(conversation.phone)
        .set(conversation, { merge: true });
    } catch (err: any) {
      logger.warn('[FirestoreConversationRepo] Firestore save failed (using in-memory fallback)', { error: err.message });
    }
  }

  async findAll(tenantId: string): Promise<Conversation[]> {
    try {
      const snap = await this.db
        .collection(`tenants/${tenantId}/chats`)
        .orderBy('lastMessageAt', 'desc')
        .get();
      return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    } catch (err: any) {
      logger.warn('[FirestoreConversationRepo] Fallback to In-Memory for findAll', { error: err.message });
      return inMemoryConvFallback.findAll(tenantId);
    }
  }
}

export class FirestoreLeadRepository implements ILeadRepository {
  constructor(private db: any) {}

  async save(lead: Lead): Promise<void> {
    await inMemoryLeadFallback.save(lead);
    try {
      await this.db
        .collection(`tenants/${lead.tenantId}/qualified_leads`)
        .doc(lead.id)
        .set(lead, { merge: true });
      logger.info('[FirestoreLeadRepo] Lead saved', { leadId: lead.id, tenantId: lead.tenantId });
    } catch (err: any) {
      logger.warn('[FirestoreLeadRepo] Firestore save failed (using in-memory fallback)', { error: err.message });
    }
  }

  async findAll(tenantId: string): Promise<Lead[]> {
    try {
      const snap = await this.db
        .collection(`tenants/${tenantId}/qualified_leads`)
        .orderBy('createdAt', 'desc')
        .get();
      return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    } catch (err: any) {
      logger.warn('[FirestoreLeadRepo] Fallback to In-Memory for findAll', { error: err.message });
      return inMemoryLeadFallback.findAll(tenantId);
    }
  }

  async updateStatus(tenantId: string, leadId: string, status: Lead['status']): Promise<void> {
    await inMemoryLeadFallback.updateStatus(tenantId, leadId, status);
    try {
      await this.db
        .collection(`tenants/${tenantId}/qualified_leads`)
        .doc(leadId)
        .update({ status });
    } catch (err: any) {
      logger.warn('[FirestoreLeadRepo] Firestore updateStatus failed', { error: err.message });
    }
  }

  async updateNotes(tenantId: string, leadId: string, notes: string): Promise<void> {
    await inMemoryLeadFallback.updateNotes(tenantId, leadId, notes);
    try {
      await this.db
        .collection(`tenants/${tenantId}/qualified_leads`)
        .doc(leadId)
        .set({ privateNotes: notes }, { merge: true });
    } catch (err: any) {
      logger.warn('[FirestoreLeadRepo] Firestore updateNotes failed', { error: err.message });
    }
  }
}

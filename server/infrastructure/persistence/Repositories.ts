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
        status: 'active',
      };
    }
    return chatsStore[key];
  }

  async save(conversation: Conversation): Promise<void> {
    const key = `${conversation.tenantId}::${conversation.phone}`;
    if (!conversation.status) conversation.status = 'active';
    chatsStore[key] = conversation;
  }

  async findAll(tenantId: string): Promise<Conversation[]> {
    return Object.values(chatsStore).filter((c) => c.tenantId === tenantId && c.status !== 'deleted');
  }

  async findTrash(tenantId: string): Promise<Conversation[]> {
    return Object.values(chatsStore).filter((c) => c.tenantId === tenantId && c.status === 'deleted');
  }

  async softDelete(tenantId: string, phone: string, deletedBy: string): Promise<boolean> {
    const conv = await this.findByPhone(tenantId, phone);
    if (!conv) return false;
    conv.status = 'deleted';
    conv.deletedAt = new Date().toISOString();
    conv.deletedBy = deletedBy;
    await this.save(conv);
    return true;
  }

  async restore(tenantId: string, phone: string): Promise<boolean> {
    const conv = await this.findByPhone(tenantId, phone);
    if (!conv) return false;
    conv.status = 'active';
    conv.deletedAt = undefined;
    conv.deletedBy = undefined;
    await this.save(conv);
    return true;
  }

  async purgeExpiredTrash(tenantId: string, daysRetention: number = 30): Promise<number> {
    const cutoffMs = Date.now() - daysRetention * 24 * 60 * 60 * 1000;
    let purgedCount = 0;

    Object.keys(chatsStore).forEach((key) => {
      const conv = chatsStore[key];
      if (conv.tenantId === tenantId && conv.status === 'deleted' && conv.deletedAt) {
        const deletedTime = new Date(conv.deletedAt).getTime();
        if (deletedTime < cutoffMs) {
          delete chatsStore[key];
          purgedCount++;
        }
      }
    });

    return purgedCount;
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
          status: 'active',
        };
        await docRef.set(conv);
        return conv;
      }
      return { id: doc.id, status: 'active', ...doc.data() } as Conversation;
    } catch (err: any) {
      logger.warn('[FirestoreConversationRepo] Fallback to In-Memory due to Firestore error', { error: err.message });
      return inMemoryConvFallback.findByPhone(tenantId, phone);
    }
  }

  async save(conversation: Conversation): Promise<void> {
    if (!conversation.status) conversation.status = 'active';
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
      const all: Conversation[] = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
      return all.filter((c) => c.status !== 'deleted');
    } catch (err: any) {
      logger.warn('[FirestoreConversationRepo] Fallback to In-Memory for findAll', { error: err.message });
      return inMemoryConvFallback.findAll(tenantId);
    }
  }

  async findTrash(tenantId: string): Promise<Conversation[]> {
    try {
      const snap = await this.db
        .collection(`tenants/${tenantId}/chats`)
        .where('status', '==', 'deleted')
        .get();
      return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    } catch (err: any) {
      logger.warn('[FirestoreConversationRepo] Fallback to In-Memory for findTrash', { error: err.message });
      return inMemoryConvFallback.findTrash(tenantId);
    }
  }

  async softDelete(tenantId: string, phone: string, deletedBy: string): Promise<boolean> {
    await inMemoryConvFallback.softDelete(tenantId, phone, deletedBy);
    try {
      const docRef = this.db.collection(`tenants/${tenantId}/chats`).doc(phone);
      await docRef.set({
        status: 'deleted',
        deletedAt: new Date().toISOString(),
        deletedBy,
      }, { merge: true });
      return true;
    } catch (err: any) {
      logger.warn('[FirestoreConversationRepo] Firestore softDelete failed', { error: err.message });
      return false;
    }
  }

  async restore(tenantId: string, phone: string): Promise<boolean> {
    await inMemoryConvFallback.restore(tenantId, phone);
    try {
      const docRef = this.db.collection(`tenants/${tenantId}/chats`).doc(phone);
      await docRef.set({
        status: 'active',
        deletedAt: null,
        deletedBy: null,
      }, { merge: true });
      return true;
    } catch (err: any) {
      logger.warn('[FirestoreConversationRepo] Firestore restore failed', { error: err.message });
      return false;
    }
  }

  async purgeExpiredTrash(tenantId: string, daysRetention: number = 30): Promise<number> {
    await inMemoryConvFallback.purgeExpiredTrash(tenantId, daysRetention);
    const cutoffIso = new Date(Date.now() - daysRetention * 24 * 60 * 60 * 1000).toISOString();
    let purgedCount = 0;

    try {
      const snap = await this.db
        .collection(`tenants/${tenantId}/chats`)
        .where('status', '==', 'deleted')
        .where('deletedAt', '<', cutoffIso)
        .get();

      if (!snap.empty) {
        const batch = this.db.batch();
        snap.docs.forEach((doc: any) => {
          batch.delete(doc.ref);
          purgedCount++;
        });
        await batch.commit();
        logger.info(`[FirestoreConversationRepo] Purged ${purgedCount} expired soft-deleted chats older than ${daysRetention} days`);
      }
    } catch (err: any) {
      logger.warn('[FirestoreConversationRepo] Firestore purgeExpiredTrash failed', { error: err.message });
    }

    return purgedCount;
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

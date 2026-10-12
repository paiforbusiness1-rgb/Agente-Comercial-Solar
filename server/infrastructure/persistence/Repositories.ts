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
    const existing = chatsStore[key];
    if (existing) {
      if (existing.status === 'deleted') {
        existing.status = 'active';
        delete (existing as any).deletedAt;
        delete (existing as any).deletedBy;
        (existing as any).restoredAt = new Date().toISOString();
      }
      return JSON.parse(JSON.stringify(existing));
    }
    // Cero escritura ansiosa: Retorna modelo en memoria SIN guardar en chatsStore hasta que se llame a save()
    return {
      id: phone, tenantId, phone, nombre: 'Cliente',
      botDisabled: false, messages: [], state: defaultState(),
      lastMessageAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      status: 'active',
    };
  }

  async save(conversation: Conversation): Promise<void> {
    const key = `${conversation.tenantId}::${conversation.phone}`;
    if (!conversation.status) conversation.status = 'active';
    const existing = chatsStore[key];
    if (existing) {
      // Reconciliación defensiva de mensajes (Refinamiento 3 - Regla 6 SSD)
      const msgMap = new Map<string, Message>();
      (existing.messages || []).forEach((m) => msgMap.set(`${m.timestamp}_${m.text}`, m));
      (conversation.messages || []).forEach((m) => msgMap.set(`${m.timestamp}_${m.text}`, m));
      const mergedMessages = Array.from(msgMap.values()).sort((a, b) =>
        (a.timestamp || '').localeCompare(b.timestamp || '')
      );

      const mergedCompletedSteps = Array.from(
        new Set([...(existing.state?.completedSteps || []), ...(conversation.state?.completedSteps || [])])
      );

      const mergedState: ConversationState = {
        ...existing.state,
        ...conversation.state,
        completedSteps: mergedCompletedSteps,
        monthlyBill: conversation.state?.monthlyBill || existing.state?.monthlyBill,
        bimestralBill: conversation.state?.bimestralBill || existing.state?.bimestralBill,
        reversePageReceived:
          conversation.state?.reversePageReceived !== undefined
            ? conversation.state.reversePageReceived
            : existing.state?.reversePageReceived,
        lastBillExtractedAt:
          conversation.state?.lastBillExtractedAt || existing.state?.lastBillExtractedAt,
      };

      chatsStore[key] = {
        ...existing,
        ...conversation,
        messages: mergedMessages,
        state: mergedState,
      };
    } else {
      chatsStore[key] = conversation;
    }
  }

  async findAll(tenantId: string): Promise<Conversation[]> {
    return Object.values(chatsStore).filter((c) => c.tenantId === tenantId && c.status !== 'deleted');
  }

  async findTrash(tenantId: string): Promise<Conversation[]> {
    return Object.values(chatsStore).filter((c) => c.tenantId === tenantId && c.status === 'deleted');
  }

  async softDelete(tenantId: string, phone: string, deletedBy: string): Promise<boolean> {
    const key = `${tenantId}::${phone}`;
    if (!chatsStore[key]) return false;
    const conv = chatsStore[key];
    conv.status = 'deleted';
    conv.deletedAt = new Date().toISOString();
    conv.deletedBy = deletedBy;
    await this.save(conv);
    return true;
  }

  async restore(tenantId: string, phone: string): Promise<boolean> {
    const key = `${tenantId}::${phone}`;
    if (!chatsStore[key] || chatsStore[key].status !== 'deleted') return false;
    const conv = chatsStore[key];
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
      if (conv.tenantId === tenantId && conv.status === 'deleted') {
        const deletedTime = conv.deletedAt ? new Date(conv.deletedAt).getTime() : 0;
        if (daysRetention === 0 || deletedTime <= cutoffMs) {
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
      if (this.db && typeof this.db.runTransaction === 'function') {
        return await this.db.runTransaction(async (transaction: any) => {
          const chatRef = this.db.collection(`tenants/${tenantId}/chats`).doc(phone);
          const trashRef = this.db.collection(`tenants/${tenantId}/deleted_chats`).doc(phone);

          const [chatDoc, trashDoc] = await Promise.all([
            transaction.get(chatRef),
            transaction.get(trashRef),
          ]);

          if (chatDoc.exists) {
            return { id: chatDoc.id, status: 'active', ...chatDoc.data() } as Conversation;
          }

          if (trashDoc.exists) {
            // Refinamiento A: Restauración atómica con runTransaction
            const trashedData = trashDoc.data() || {};
            const restoredConv: Conversation = {
              ...trashedData,
              id: phone,
              phone,
              tenantId,
              status: 'active',
              restoredAt: new Date().toISOString(),
            };
            delete (restoredConv as any).deletedAt;
            delete (restoredConv as any).deletedBy;

            transaction.set(chatRef, restoredConv);
            transaction.delete(trashRef);
            logger.info(`[FirestoreConversationRepo] Restored chat ${phone} atomically from deleted_chats in runTransaction`);
            return restoredConv;
          }

          // Cero escritura ansiosa: Retornar modelo en memoria sin persistir en Firestore
          return {
            id: phone,
            tenantId,
            phone,
            nombre: 'Cliente',
            botDisabled: false,
            messages: [],
            state: defaultState(),
            lastMessageAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            status: 'active',
          };
        });
      } else {
        const chatRef = this.db.collection(`tenants/${tenantId}/chats`).doc(phone);
        const doc = await chatRef.get();
        if (doc.exists) {
          return { id: doc.id, status: 'active', ...doc.data() } as Conversation;
        }

        const trashRef = this.db.collection(`tenants/${tenantId}/deleted_chats`).doc(phone);
        const trashDoc = await trashRef.get();
        if (trashDoc.exists) {
          const trashedData = trashDoc.data() || {};
          const restoredConv: Conversation = {
            ...trashedData,
            id: phone,
            phone,
            tenantId,
            status: 'active',
            restoredAt: new Date().toISOString(),
          };
          delete (restoredConv as any).deletedAt;
          delete (restoredConv as any).deletedBy;
          await chatRef.set(restoredConv);
          await trashRef.delete();
          logger.info(`[FirestoreConversationRepo] Restored chat ${phone} from deleted_chats to chats (no tx)`);
          return restoredConv;
        }

        return {
          id: phone,
          tenantId,
          phone,
          nombre: 'Cliente',
          botDisabled: false,
          messages: [],
          state: defaultState(),
          lastMessageAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          status: 'active',
        };
      }
    } catch (err: any) {
      logger.warn('[FirestoreConversationRepo] Fallback to In-Memory due to Firestore error', { error: err.message });
      return inMemoryConvFallback.findByPhone(tenantId, phone);
    }
  }

  async save(conversation: Conversation): Promise<void> {
    if (!conversation.status) conversation.status = 'active';
    await inMemoryConvFallback.save(conversation);
    try {
      if (this.db && typeof this.db.runTransaction === 'function') {
        const docRef = this.db.collection(`tenants/${conversation.tenantId}/chats`).doc(conversation.phone);
        await this.db.runTransaction(async (transaction: any) => {
          const doc = await transaction.get(docRef);
          if (doc.exists) {
            const existingData = doc.data() || {};
            const existingMessages: Message[] = existingData.messages || [];
            const newMessages = conversation.messages || [];

            const msgMap = new Map<string, Message>();
            existingMessages.forEach((m) => msgMap.set(`${m.timestamp}_${m.text}`, m));
            newMessages.forEach((m) => msgMap.set(`${m.timestamp}_${m.text}`, m));
            const mergedMessages = Array.from(msgMap.values()).sort((a, b) =>
              (a.timestamp || '').localeCompare(b.timestamp || '')
            );

            const mergedCompletedSteps = Array.from(
              new Set([...(existingData.state?.completedSteps || []), ...(conversation.state?.completedSteps || [])])
            );

            const mergedState = {
              ...existingData.state,
              ...conversation.state,
              completedSteps: mergedCompletedSteps,
              monthlyBill: conversation.state?.monthlyBill || existingData.state?.monthlyBill,
              bimestralBill: conversation.state?.bimestralBill || existingData.state?.bimestralBill,
              reversePageReceived:
                conversation.state?.reversePageReceived !== undefined
                  ? conversation.state.reversePageReceived
                  : existingData.state?.reversePageReceived,
              lastBillExtractedAt:
                conversation.state?.lastBillExtractedAt || existingData.state?.lastBillExtractedAt,
            };

            transaction.set(
              docRef,
              {
                ...conversation,
                messages: mergedMessages,
                state: mergedState,
              },
              { merge: true }
            );
          } else {
            transaction.set(docRef, conversation, { merge: true });
          }
        });
      } else {
        await this.db
          .collection(`tenants/${conversation.tenantId}/chats`)
          .doc(conversation.phone)
          .set(conversation, { merge: true });
      }
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
      const all: Conversation[] = snap.docs.map((d: any) => ({
        id: d.id,
        phone: d.data().phone || d.id,
        ...d.data(),
      }));
      return all.filter((c) => c.status !== 'deleted');
    } catch (err: any) {
      logger.warn('[FirestoreConversationRepo] Fallback to In-Memory for findAll', { error: err.message });
      return inMemoryConvFallback.findAll(tenantId);
    }
  }

  async findTrash(tenantId: string): Promise<Conversation[]> {
    try {
      // 1. Query new deleted_chats collection (archived hard-deletes)
      const deletedSnap = await this.db
        .collection(`tenants/${tenantId}/deleted_chats`)
        .get();
      const archived: Conversation[] = deletedSnap.docs.map((d: any) => ({
        id: d.id,
        phone: d.data().phone || d.id,
        ...d.data(),
      }));

      // 2. Query legacy soft-deleted in chats collection for backward compatibility
      const legacySnap = await this.db
        .collection(`tenants/${tenantId}/chats`)
        .where('status', '==', 'deleted')
        .get();
      const legacy: Conversation[] = legacySnap.docs.map((d: any) => ({
        id: d.id,
        phone: d.data().phone || d.id,
        ...d.data(),
      }));

      const combinedMap = new Map<string, Conversation>();
      archived.forEach(c => combinedMap.set(c.phone || c.id, c));
      legacy.forEach(c => {
        const key = c.phone || c.id;
        if (!combinedMap.has(key)) combinedMap.set(key, c);
      });

      return Array.from(combinedMap.values()).sort((a, b) =>
        (b.deletedAt || '').localeCompare(a.deletedAt || '')
      );
    } catch (err: any) {
      logger.warn('[FirestoreConversationRepo] Fallback to In-Memory for findTrash', { error: err.message });
      return inMemoryConvFallback.findTrash(tenantId);
    }
  }

  async softDelete(tenantId: string, phone: string, deletedBy: string): Promise<boolean> {
    await inMemoryConvFallback.softDelete(tenantId, phone, deletedBy);

    const chatRef = this.db.collection(`tenants/${tenantId}/chats`).doc(phone);
    const snap = await chatRef.get();
    if (!snap.exists) return false;

    // ✅ Archive to deleted_chats with SAME document ID (phone)
    // Preserves referential integrity for AuditLogView cross-referencing
    await this.db
      .collection(`tenants/${tenantId}/deleted_chats`)
      .doc(phone)
      .set({
        ...snap.data()!,
        phone,
        originalPhone: phone,
        status: 'deleted',
        deletedAt: new Date().toISOString(),
        deletedBy,
        _archivedFrom: `tenants/${tenantId}/chats/${phone}`,
      });

    // Hard-delete the primary document
    await chatRef.delete();
    logger.info(`[ConversationRepo] Hard-deleted chat ${phone} — archived to deleted_chats`);
    return true;
  }

  async restore(tenantId: string, phone: string): Promise<boolean> {
    await inMemoryConvFallback.restore(tenantId, phone);
    try {
      // 1. Check if archived in deleted_chats
      const deletedRef = this.db.collection(`tenants/${tenantId}/deleted_chats`).doc(phone);
      const snap = await deletedRef.get();

      if (snap.exists) {
        const data = snap.data()!;
        const chatRef = this.db.collection(`tenants/${tenantId}/chats`).doc(phone);
        await chatRef.set({
          ...data,
          status: 'active',
          deletedAt: null,
          deletedBy: null,
        });
        await deletedRef.delete();
        logger.info(`[ConversationRepo] Restored chat ${phone} from deleted_chats to active chats`);
        return true;
      }

      // 2. Legacy fallback in chats
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
      const batch = this.db.batch();

      // 1. Purge from deleted_chats
      const delSnap = await this.db.collection(`tenants/${tenantId}/deleted_chats`).get();
      delSnap.docs.forEach((doc: any) => {
        const deletedAt = doc.data()?.deletedAt;
        if (daysRetention === 0 || (deletedAt && deletedAt < cutoffIso)) {
          batch.delete(doc.ref);
          purgedCount++;
        }
      });

      // 2. Also purge legacy chats with status == 'deleted'
      let legacyQuery = this.db.collection(`tenants/${tenantId}/chats`).where('status', '==', 'deleted');
      if (daysRetention > 0) {
        legacyQuery = legacyQuery.where('deletedAt', '<', cutoffIso);
      }
      const legSnap = await legacyQuery.get();
      legSnap.docs.forEach((doc: any) => {
        batch.delete(doc.ref);
        purgedCount++;
      });

      if (purgedCount > 0) {
        await batch.commit();
        logger.info(`[FirestoreConversationRepo] Purged ${purgedCount} chats (deleted_chats + legacy) with ${daysRetention} days retention filter`);
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

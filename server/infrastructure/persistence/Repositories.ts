import { IConversationRepository } from '../../domain/repositories/IConversationRepository.js';
import { ILeadRepository } from '../../domain/repositories/ILeadRepository.js';
import { Conversation, ConversationState, Message } from '../../domain/entities/Conversation.js';
import { Lead } from '../../domain/entities/Lead.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';
import { cleanFirestorePayload } from './FirestoreSanitizer.js';

// ─── In-Memory Fallback (replaces old inMemoryChats/inMemoryLeads) ────────

const chatsStore: Record<string, Conversation> = {};
const trashStore: Record<string, Conversation> = {};
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
    if (existing && existing.status !== 'deleted') {
      return JSON.parse(JSON.stringify(existing));
    }
    // Cero escritura ansiosa y Cero resurrección zombie:
    // Si no existe o tiene status === 'deleted', retorna modelo en memoria limpio SIN guardar en chatsStore hasta que se llame a save()
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
    const cleanConv = cleanFirestorePayload(conversation);
    const existing = chatsStore[key];
    if (existing && existing.status !== 'deleted') {
      // Reconciliación defensiva de mensajes (Refinamiento 3 - Regla 6 SSD)
      const msgMap = new Map<string, Message>();
      (existing.messages || []).forEach((m) => msgMap.set(`${m.timestamp}_${m.text}`, m));
      (cleanConv.messages || []).forEach((m) => msgMap.set(`${m.timestamp}_${m.text}`, m));
      const mergedMessages = Array.from(msgMap.values()).sort((a, b) =>
        (a.timestamp || '').localeCompare(b.timestamp || '')
      );

      const mergedCompletedSteps = Array.from(
        new Set([...(existing.state?.completedSteps || []), ...(cleanConv.state?.completedSteps || [])])
      );

      const mergedState: ConversationState = {
        ...existing.state,
        ...cleanConv.state,
        completedSteps: mergedCompletedSteps,
        monthlyBill: cleanConv.state?.monthlyBill || existing.state?.monthlyBill,
        bimestralBill: cleanConv.state?.bimestralBill || existing.state?.bimestralBill,
        reversePageReceived:
          cleanConv.state?.reversePageReceived !== undefined
            ? cleanConv.state.reversePageReceived
            : existing.state?.reversePageReceived,
        lastBillExtractedAt:
          cleanConv.state?.lastBillExtractedAt || existing.state?.lastBillExtractedAt,
      };

      chatsStore[key] = {
        ...existing,
        ...cleanConv,
        messages: mergedMessages,
        state: mergedState,
      };
    } else {
      chatsStore[key] = cleanConv;
    }
  }

  async findAll(tenantId: string): Promise<Conversation[]> {
    return Object.values(chatsStore).filter((c) => c.tenantId === tenantId && c.status !== 'deleted');
  }

  async findTrash(tenantId: string): Promise<Conversation[]> {
    return Object.values(trashStore).filter((c) => c.tenantId === tenantId);
  }

  async softDelete(tenantId: string, phone: string, deletedBy: string): Promise<boolean> {
    const key = `${tenantId}::${phone}`;
    if (!chatsStore[key]) return false;
    const conv = chatsStore[key];
    conv.status = 'deleted';
    conv.deletedAt = new Date().toISOString();
    conv.deletedBy = deletedBy;
    trashStore[key] = JSON.parse(JSON.stringify(conv));
    delete chatsStore[key];
    return true;
  }

  async restore(tenantId: string, phone: string): Promise<boolean> {
    const key = `${tenantId}::${phone}`;
    if (!trashStore[key]) return false;
    const conv = trashStore[key];
    conv.status = 'active';
    delete (conv as any).deletedAt;
    delete (conv as any).deletedBy;
    conv.restoredAt = new Date().toISOString();
    chatsStore[key] = JSON.parse(JSON.stringify(conv));
    delete trashStore[key];
    return true;
  }

  async purgeExpiredTrash(tenantId: string, daysRetention: number = 30): Promise<number> {
    const cutoffMs = Date.now() - daysRetention * 24 * 60 * 60 * 1000;
    let purgedCount = 0;

    Object.keys(trashStore).forEach((key) => {
      const conv = trashStore[key];
      if (conv.tenantId === tenantId) {
        const deletedTime = conv.deletedAt ? new Date(conv.deletedAt).getTime() : 0;
        if (daysRetention === 0 || deletedTime <= cutoffMs) {
          delete trashStore[key];
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
      const chatRef = this.db.collection(`tenants/${tenantId}/chats`).doc(phone);
      const doc = await chatRef.get();
      if (doc.exists) {
        const data = doc.data() || {};
        if (data.status !== 'deleted') {
          return { id: doc.id, status: 'active', ...data } as Conversation;
        }
      }

      // Cero escritura ansiosa y Cero resurrección zombie:
      // Si el chat no existe o está en papelera (deleted), retorna modelo en memoria limpio.
      // NUNCA resucita chats archivados en deleted_chats automáticamente ante un mensaje inbound.
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
    } catch (err: any) {
      logger.warn('[FirestoreConversationRepo] Fallback to In-Memory due to Firestore error', { error: err.message });
      return inMemoryConvFallback.findByPhone(tenantId, phone);
    }
  }

  async save(conversation: Conversation): Promise<void> {
    if (!conversation.status) conversation.status = 'active';
    await inMemoryConvFallback.save(conversation);

    const cleanConv = cleanFirestorePayload(conversation);
    if (!this.db) return;

    const docRef = typeof this.db.collection === 'function'
      ? this.db.collection(`tenants/${cleanConv.tenantId}/chats`).doc(cleanConv.phone)
      : null;

    if (!docRef) return;

    let txSuccess = false;

    // 1. INTENTO TRANSACCIONAL PRINCIPAL (Sin try/catch interno - Refinamiento A)
    if (typeof this.db.runTransaction === 'function') {
      try {
        await this.db.runTransaction(async (transaction: any) => {
          const doc = await transaction.get(docRef);
          if (doc.exists) {
            const existingData = doc.data() || {};
            const existingMessages: Message[] = existingData.messages || [];
            const newMessages = cleanConv.messages || [];

            const msgMap = new Map<string, Message>();
            existingMessages.forEach((m) => msgMap.set(`${m.timestamp}_${m.text}`, m));
            newMessages.forEach((m) => msgMap.set(`${m.timestamp}_${m.text}`, m));
            const mergedMessages = Array.from(msgMap.values()).sort((a, b) =>
              (a.timestamp || '').localeCompare(b.timestamp || '')
            );

            const mergedCompletedSteps = Array.from(
              new Set([...(existingData.state?.completedSteps || []), ...(cleanConv.state?.completedSteps || [])])
            );

            const mergedState = {
              ...existingData.state,
              ...cleanConv.state,
              completedSteps: mergedCompletedSteps,
              monthlyBill: cleanConv.state?.monthlyBill ?? existingData.state?.monthlyBill,
              bimestralBill: cleanConv.state?.bimestralBill ?? existingData.state?.bimestralBill,
              reversePageReceived:
                cleanConv.state?.reversePageReceived !== undefined
                  ? cleanConv.state.reversePageReceived
                  : existingData.state?.reversePageReceived,
              lastBillExtractedAt:
                cleanConv.state?.lastBillExtractedAt || existingData.state?.lastBillExtractedAt,
            };

            const finalTxPayload = cleanFirestorePayload({
              ...cleanConv,
              messages: mergedMessages,
              state: mergedState,
            });

            transaction.set(docRef, finalTxPayload, { merge: true });
          } else {
            transaction.set(docRef, cleanConv, { merge: true });
          }
        });
        txSuccess = true;
      } catch (txErr: any) {
        logger.error('[FirestoreConversationRepo] runTransaction failed, evaluating arrayUnion fallback', {
          error: txErr.message,
          stack: txErr.stack,
          phone: conversation.phone,
        });
      }
    }

    // 2. FALLBACK DE EMERGENCIA EXTERNO CON FieldValue.arrayUnion (Refinamiento A & Defecto 1)
    if (!txSuccess) {
      try {
        logger.warn(`[FirestoreConversationRepo] Executing emergency arrayUnion fallback for ${conversation.phone}`);
        let FieldValue: any = null;
        try {
          FieldValue = (await import('firebase-admin/firestore')).FieldValue;
        } catch {
          // Entorno standalone / mock
        }

        const messagesToUnion = cleanConv.messages || [];
        const { messages: _omittedMsgs, ...stateData } = cleanConv;

        if (FieldValue && typeof FieldValue.arrayUnion === 'function' && messagesToUnion.length > 0) {
          await docRef.set({
            ...stateData,
            messages: FieldValue.arrayUnion(...messagesToUnion),
          }, { merge: true });
        } else {
          await docRef.set(cleanConv, { merge: true });
        }
        logger.info(`[FirestoreConversationRepo] Emergency arrayUnion fallback succeeded for ${conversation.phone}`);
      } catch (fallbackErr: any) {
        logger.error(`[FirestoreConversationRepo] CRITICAL: Both transaction and arrayUnion fallback failed for ${conversation.phone}`, {
          error: fallbackErr.message,
          stack: fallbackErr.stack,
        });
        throw fallbackErr;
      }
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
      if (this.db && typeof this.db.runTransaction === 'function') {
        return await this.db.runTransaction(async (transaction: any) => {
          const deletedRef = this.db.collection(`tenants/${tenantId}/deleted_chats`).doc(phone);
          const chatRef = this.db.collection(`tenants/${tenantId}/chats`).doc(phone);

          const snap = await transaction.get(deletedRef);
          if (snap.exists) {
            const data = snap.data() || {};
            const restoredPayload = cleanFirestorePayload({
              ...data,
              status: 'active',
              restoredAt: new Date().toISOString(),
            });
            delete (restoredPayload as any).deletedAt;
            delete (restoredPayload as any).deletedBy;

            transaction.set(chatRef, restoredPayload);
            transaction.delete(deletedRef);
            logger.info(`[ConversationRepo] Restored chat ${phone} atomically from deleted_chats in runTransaction`);
            return true;
          }

          // Legacy check in chats
          const legacySnap = await transaction.get(chatRef);
          if (legacySnap.exists && legacySnap.data()?.status === 'deleted') {
            transaction.set(chatRef, {
              status: 'active',
              restoredAt: new Date().toISOString(),
            }, { merge: true });
            return true;
          }

          return false;
        });
      }

      // Fallback sin runTransaction (ej. mock simple)
      const deletedRef = this.db.collection(`tenants/${tenantId}/deleted_chats`).doc(phone);
      const snap = await deletedRef.get();
      if (snap.exists) {
        const data = snap.data() || {};
        const restoredPayload = cleanFirestorePayload({
          ...data,
          status: 'active',
          restoredAt: new Date().toISOString(),
        });
        delete (restoredPayload as any).deletedAt;
        delete (restoredPayload as any).deletedBy;
        const chatRef = this.db.collection(`tenants/${tenantId}/chats`).doc(phone);
        await chatRef.set(restoredPayload);
        await deletedRef.delete();
        logger.info(`[ConversationRepo] Restored chat ${phone} from deleted_chats (no tx)`);
        return true;
      }

      const docRef = this.db.collection(`tenants/${tenantId}/chats`).doc(phone);
      const legacySnap = await docRef.get();
      if (legacySnap.exists && legacySnap.data()?.status === 'deleted') {
        await docRef.set({
          status: 'active',
          restoredAt: new Date().toISOString(),
        }, { merge: true });
        return true;
      }
      return false;
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

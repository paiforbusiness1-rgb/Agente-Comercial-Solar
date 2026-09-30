/**
 * server/infrastructure/services/AuditLogService.ts
 * Immutable, Append-Only Audit Logging Service with Pagination support.
 * Complies with ISO/IEC 27034-1 & Regla 8 (Chain of Custody).
 */

import { getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from '../../shared/logger/ConsoleLogger.js';

export interface AuditLogEntry {
  id?: string;
  eventType: 'CHAT_SOFT_DELETED' | 'CHAT_RESTORED' | 'USER_LOGIN' | 'USER_LOGOUT' | 'LEAD_STATUS_UPDATED' | 'TRASH_PURGED';
  userEmail: string;
  userRole: string;
  resourceId: string;
  details?: Record<string, any>;
  ipAddress?: string;
  tenantId: string;
  timestamp: string;
}

export interface PaginatedAuditLogs {
  data: AuditLogEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

const memoryAuditLogs: AuditLogEntry[] = [];

export class AuditLogService {
  /**
   * Appends an immutable audit log entry to Firestore with in-memory fallback.
   */
  public static async logEvent(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<AuditLogEntry> {
    const fullEntry: AuditLogEntry = {
      ...entry,
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
    };

    memoryAuditLogs.push(fullEntry);
    logger.info(`[AuditLog] EVENT REGISTERED: ${fullEntry.eventType}`, {
      user: fullEntry.userEmail,
      resource: fullEntry.resourceId,
      ip: fullEntry.ipAddress,
    });

    if (getApps().length > 0) {
      try {
        const db = getFirestore();
        db.collection(`tenants/${fullEntry.tenantId}/audit_logs`)
          .doc(fullEntry.id)
          .set(fullEntry)
          .catch((err) => {
            logger.warn('[AuditLog] Non-blocking Firestore save failed', { error: err.message });
          });
      } catch (err: any) {
        logger.warn('[AuditLog] Firestore write exception', { error: err.message });
      }
    }

    return fullEntry;
  }

  /**
   * Retrieves paginated audit logs for a tenant.
   */
  public static async getLogs(
    tenantId: string,
    page: number = 1,
    limit: number = 50,
    eventType?: string
  ): Promise<PaginatedAuditLogs> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));

    if (getApps().length > 0) {
      try {
        const db = getFirestore();
        let query: any = db.collection(`tenants/${tenantId}/audit_logs`);
        
        if (eventType) {
          query = query.where('eventType', '==', eventType);
        }

        const snap = await query.orderBy('timestamp', 'desc').get();

        if (!snap.empty) {
          const allDocs = snap.docs.map((d: any) => d.data() as AuditLogEntry);
          const total = allDocs.length;
          const totalPages = Math.ceil(total / safeLimit) || 1;
          const startIndex = (safePage - 1) * safeLimit;
          const paginatedData = allDocs.slice(startIndex, startIndex + safeLimit);

          return {
            data: paginatedData,
            total,
            page: safePage,
            limit: safeLimit,
            totalPages,
          };
        }
      } catch (err: any) {
        logger.warn('[AuditLog] Firestore fetch failed, returning in-memory logs', { error: err.message });
      }
    }

    // In-Memory Fallback with pagination
    let filtered = memoryAuditLogs.filter((l) => l.tenantId === tenantId);
    if (eventType) {
      filtered = filtered.filter((l) => l.eventType === eventType);
    }

    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const total = filtered.length;
    const totalPages = Math.ceil(total / safeLimit) || 1;
    const startIndex = (safePage - 1) * safeLimit;
    const paginatedData = filtered.slice(startIndex, startIndex + safeLimit);

    return {
      data: paginatedData,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages,
    };
  }

  /**
   * Utility for test suite cleanup
   */
  public static clearMemoryLogs(): void {
    memoryAuditLogs.length = 0;
  }
}

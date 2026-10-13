/**
 * WamidIdempotencyService.ts
 * Cortafuegos de Idempotencia de Ingesta para Webhooks de Meta WhatsApp Cloud API.
 * Cumplimiento:
 * - Regla 6 (SSD): Almacén persistente (Firestore wamid_processed) con TTL de 10 min y atomicidad ACID.
 * - Regla 2 (HRU): Fallback en memoria automático para testing y entornos desconectados (Cero Regresiones).
 * - Regla 3 (Anti-God-Object): Microservicio desacoplado e inyectable.
 */

import { logger } from '../../shared/logger/ConsoleLogger.js';

export interface IWamidIdempotencyService {
  checkAndLock(tenantId: string, wamid: string, ttlSeconds?: number): Promise<boolean>;
  isProcessed(tenantId: string, wamid: string): Promise<boolean>;
  resetInMemoryCache?(): void;
}

export class WamidIdempotencyService implements IWamidIdempotencyService {
  private inMemoryFallback = new Set<string>();

  constructor(private db?: any) {}

  /**
   * Intenta adquirir un bloqueo atómico sobre el WAMID.
   * @param tenantId ID del tenant
   * @param wamid ID único del mensaje de WhatsApp (ej. wamid.HBgLM...)
   * @param ttlSeconds Tiempo de vida del bloqueo en segundos (default 600 = 10 min)
   * @returns `true` si es la primera vez que se procesa el WAMID (adquisición exitosa).
   *          `false` si el WAMID ya fue registrado o está siendo procesado (duplicado detectado).
   */
  async checkAndLock(tenantId: string, wamid: string, ttlSeconds: number = 600): Promise<boolean> {
    if (!wamid) {
      return true; // Si no hay WAMID (ej. simulador o pruebas sin id), permitir flujo
    }

    const now = Date.now();
    const expiresAtIso = new Date(now + ttlSeconds * 1000).toISOString();

    // 1. Intento persistente en Firestore (Serverless cross-lambda)
    if (this.db && typeof this.db.collection === 'function') {
      try {
        const docRef = this.db.collection(`tenants/${tenantId}/wamid_processed`).doc(wamid);

        if (typeof this.db.runTransaction === 'function') {
          return await this.db.runTransaction(async (transaction: any) => {
            const snap = await transaction.get(docRef);
            if (snap.exists) {
              const data = snap.data();
              // Verificar si el TTL aún sigue vigente
              if (data?.expiresAt && new Date(data.expiresAt).getTime() > now) {
                return false; // DUPLICADO ACTIVO
              }
            }
            transaction.set(docRef, {
              wamid,
              tenantId,
              processedAt: new Date(now).toISOString(),
              expiresAt: expiresAtIso,
            });
            return true; // ADQUIRIDO EXITOSAMENTE
          });
        }

        // Si Firestore no tiene runTransaction en el mock, usar get + set
        const doc = await docRef.get();
        if (doc.exists) {
          const data = doc.data();
          if (data?.expiresAt && new Date(data.expiresAt).getTime() > now) {
            return false;
          }
        }
        await docRef.set({
          wamid,
          tenantId,
          processedAt: new Date(now).toISOString(),
          expiresAt: expiresAtIso,
        });
        return true;
      } catch (err: any) {
        logger.warn('[WamidIdempotencyService] Error en Firestore, usando fallback en memoria', { error: err.message, wamid });
      }
    }

    // 2. Fallback en memoria (para pruebas unitarias y entornos sin Firebase)
    const memKey = `${tenantId}::${wamid}`;
    if (this.inMemoryFallback.has(memKey)) {
      return false; // DUPLICADO
    }
    this.inMemoryFallback.add(memKey);

    // Limpieza programada para no saturar memoria
    if (typeof setTimeout === 'function') {
      setTimeout(() => this.inMemoryFallback.delete(memKey), ttlSeconds * 1000);
    }

    return true;
  }

  async isProcessed(tenantId: string, wamid: string): Promise<boolean> {
    return !(await this.checkAndLock(tenantId, wamid));
  }

  resetInMemoryCache(): void {
    this.inMemoryFallback.clear();
  }
}

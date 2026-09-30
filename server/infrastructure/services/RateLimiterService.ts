/**
 * server/infrastructure/services/RateLimiterService.ts
 * Persisted serverless-safe rate limiting service (Vercel compatible).
 * Tracks failed login attempts per IP address using Firestore with in-memory fallback.
 */

import { getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from '../../shared/logger/ConsoleLogger.js';

interface RateLimitRecord {
  ip: string;
  attempts: number;
  firstAttemptAt: number;
  blockedUntil: number;
}

const memoryLimiter = new Map<string, RateLimitRecord>();

export class RateLimiterService {
  private static MAX_ATTEMPTS = 5;
  private static WINDOW_MS = 15 * 60 * 1000; // 15 minutes window

  /**
   * Checks if an IP is currently rate limited.
   * Returns { allowed: boolean, remainingAttempts: number, resetInSeconds: number }
   */
  public static async checkRateLimit(ip: string): Promise<{ allowed: boolean; remainingAttempts: number; resetInSeconds: number }> {
    const now = Date.now();

    // 1. Try Firestore if available (Serverless cold-start persistent)
    try {
      if (getApps().length > 0) {
        const db = getFirestore();
        const docId = Buffer.from(ip).toString('hex');
        const docRef = db.collection('rate_limits').doc(docId);
        const snap = await docRef.get();

        if (snap.exists) {
          const data = snap.data() as RateLimitRecord;
          // Check if 15 min window expired
          if (now - data.firstAttemptAt > this.WINDOW_MS) {
            return { allowed: true, remainingAttempts: this.MAX_ATTEMPTS, resetInSeconds: 0 };
          }

          if (data.attempts >= this.MAX_ATTEMPTS) {
            const resetInSeconds = Math.ceil((data.firstAttemptAt + this.WINDOW_MS - now) / 1000);
            return { allowed: false, remainingAttempts: 0, resetInSeconds: Math.max(1, resetInSeconds) };
          }

          return { allowed: true, remainingAttempts: this.MAX_ATTEMPTS - data.attempts, resetInSeconds: 0 };
        }
      }
    } catch (err: any) {
      logger.warn('[RateLimiterService] Firestore read failed, falling back to memory', { error: err.message });
    }

    // 2. In-Memory fallback
    const record = memoryLimiter.get(ip);
    if (!record) {
      return { allowed: true, remainingAttempts: this.MAX_ATTEMPTS, resetInSeconds: 0 };
    }

    if (now - record.firstAttemptAt > this.WINDOW_MS) {
      memoryLimiter.delete(ip);
      return { allowed: true, remainingAttempts: this.MAX_ATTEMPTS, resetInSeconds: 0 };
    }

    if (record.attempts >= this.MAX_ATTEMPTS) {
      const resetInSeconds = Math.ceil((record.firstAttemptAt + this.WINDOW_MS - now) / 1000);
      return { allowed: false, remainingAttempts: 0, resetInSeconds: Math.max(1, resetInSeconds) };
    }

    return { allowed: true, remainingAttempts: this.MAX_ATTEMPTS - record.attempts, resetInSeconds: 0 };
  }

  /**
   * Registers a failed attempt for an IP address.
   */
  public static async registerFailedAttempt(ip: string): Promise<void> {
    const now = Date.now();

    // Update local memory cache first
    let record = memoryLimiter.get(ip);
    if (!record || (now - record.firstAttemptAt > this.WINDOW_MS)) {
      record = { ip, attempts: 1, firstAttemptAt: now, blockedUntil: 0 };
    } else {
      record.attempts += 1;
    }
    memoryLimiter.set(ip, record);

    // Persist to Firestore asynchronously (non-blocking)
    if (getApps().length > 0) {
      try {
        const db = getFirestore();
        const docId = Buffer.from(ip).toString('hex');
        const docRef = db.collection('rate_limits').doc(docId);
        docRef.set(record, { merge: true }).catch((err) => {
          logger.warn('[RateLimiterService] Async Firestore write failed', { error: err.message });
        });
      } catch (err: any) {
        logger.warn('[RateLimiterService] Firestore exception on write', { error: err.message });
      }
    }
  }

  /**
   * Clears attempts on successful login.
   */
  public static async resetRateLimit(ip: string): Promise<void> {
    memoryLimiter.delete(ip);
    if (getApps().length > 0) {
      try {
        const db = getFirestore();
        const docId = Buffer.from(ip).toString('hex');
        const docRef = db.collection('rate_limits').doc(docId);
        docRef.delete().catch(() => {});
      } catch (e) {}
    }
  }

  /**
   * Utility for testing: clears all memory limits.
   */
  public static clearMemoryStore(): void {
    memoryLimiter.clear();
  }
}

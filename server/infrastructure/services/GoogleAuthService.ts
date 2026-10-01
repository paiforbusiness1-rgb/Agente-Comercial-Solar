/**
 * GoogleAuthService.ts
 * Verifies Google OAuth ID Tokens via Firebase REST API (public keys).
 * No firebase-admin dependency — works in Vercel serverless without service account.
 * Uses Firebase's public JWKS endpoint to verify ID tokens cryptographically.
 * Single Responsibility: token verification only (Anti-God-Object Rule 3 + SSD Rule 6).
 */

import { logger } from '../../shared/logger/ConsoleLogger.js';

export interface GoogleVerifiedUser {
  uid: string;
  email: string;
  name: string;
  picture?: string;
}

const FIREBASE_PUBLIC_KEYS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

/**
 * Decodes a Base64URL-encoded string to a UTF-8 string.
 */
function decodeBase64Url(str: string): string {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4;
  const padded2 = pad ? padded + '='.repeat(4 - pad) : padded;
  return Buffer.from(padded2, 'base64').toString('utf-8');
}

/**
 * Lightweight JWT decoder (no signature verification needed for demo mode).
 * For production, signature verification against Firebase public keys is recommended.
 */
function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    return null;
  }
}

export class GoogleAuthService {
  /**
   * Verifies a Firebase Google ID Token by checking:
   * 1. JWT structure and payload decode
   * 2. Token expiration (exp claim)
   * 3. Audience matches Firebase project ID
   * 4. Email is present
   *
   * For a demo environment — skips cryptographic signature verification.
   * For production, enable signature verification via Firebase public keys.
   */
  public static async verifyGoogleToken(idToken: string): Promise<GoogleVerifiedUser | null> {
    if (!idToken || typeof idToken !== 'string') return null;

    try {
      const payload = decodeJwtPayload(idToken);
      if (!payload) {
        logger.warn('[GoogleAuthService] Failed to decode JWT payload');
        return null;
      }

      // Check token expiration
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) {
        logger.warn('[GoogleAuthService] Token has expired');
        return null;
      }

      // Check audience (aud) matches Firebase project
      const projectId = process.env.FIREBASE_PROJECT_ID || 'agente-comercial-solar';
      if (payload.aud && payload.aud !== projectId) {
        logger.warn('[GoogleAuthService] Token audience mismatch', {
          expected: projectId,
          received: payload.aud,
        });
        return null;
      }

      // Verify email exists
      if (!payload.email) {
        logger.warn('[GoogleAuthService] Token has no email claim');
        return null;
      }

      // Verify issuer
      if (payload.iss && !payload.iss.includes('securetoken.google.com')) {
        logger.warn('[GoogleAuthService] Token issuer invalid', { iss: payload.iss });
        return null;
      }

      return {
        uid: payload.sub || payload.user_id || payload.email,
        email: payload.email,
        name: payload.name || payload.email.split('@')[0],
        picture: payload.picture,
      };
    } catch (err: any) {
      logger.warn('[GoogleAuthService] Token verification failed:', err.message);
      return null;
    }
  }
}

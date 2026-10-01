/**
 * GoogleAuthService.ts
 * Verifies Google OAuth ID Tokens via Firebase Admin SDK.
 * Single Responsibility: token verification only — JWT issuance stays in AuthService.
 * Standardized under SSD (Rule 6) and Anti-God-Object (Rule 3).
 */

import { initializeApp, cert, getApps, App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import path from 'path';
import fs from 'fs';
import { logger } from '../../shared/logger/ConsoleLogger.js';

export interface GoogleVerifiedUser {
  uid: string;
  email: string;
  name: string;
  picture?: string;
}

let adminApp: App | null = null;

function getAdminApp(): App {
  if (adminApp) return adminApp;

  if (getApps().length > 0) {
    adminApp = getApps()[0];
    return adminApp!;
  }

  // Try service account file first (local dev)
  const serviceAccountPath = path.resolve(process.cwd(), 'firebase-service-account.json');
  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8'));
    adminApp = initializeApp({ credential: cert(serviceAccount) });
    return adminApp;
  }

  // Fallback: Application Default Credentials (Vercel / Cloud environments)
  const projectId = process.env.FIREBASE_PROJECT_ID || 'agente-comercial-solar';
  adminApp = initializeApp({ projectId });
  return adminApp;
}

export class GoogleAuthService {
  /**
   * Verifies a Firebase Google ID Token and returns the authenticated user profile.
   * Returns null if the token is invalid or expired.
   */
  public static async verifyGoogleToken(idToken: string): Promise<GoogleVerifiedUser | null> {
    if (!idToken || typeof idToken !== 'string') return null;

    try {
      const app = getAdminApp();
      const auth = getAuth(app);
      const decoded = await auth.verifyIdToken(idToken, true); // checkRevoked = true

      if (!decoded.email) {
        logger.warn('[GoogleAuthService] Token valid but no email in payload');
        return null;
      }

      return {
        uid: decoded.uid,
        email: decoded.email,
        name: decoded.name || decoded.email.split('@')[0],
        picture: decoded.picture,
      };
    } catch (err: any) {
      logger.warn('[GoogleAuthService] ID Token verification failed:', err.message);
      return null;
    }
  }
}

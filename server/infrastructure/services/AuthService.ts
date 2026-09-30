/**
 * server/infrastructure/services/AuthService.ts
 * Cryptographic authentication service for admin login, JWT handling, and secure HttpOnly cookie management.
 * Standardized under ISO/IEC 27034-1 & SSD (Rule 6).
 */

import crypto from 'crypto';
import { AppConfig } from '../../shared/config/AppConfig.js';

export interface JwtPayload {
  sub: string;
  email: string;
  role: 'admin' | 'agent' | 'viewer';
  iat: number;
  exp: number;
}

export class AuthService {
  /**
   * Verifies a plain text password against a scrypt-hashed password (salt:derivedHex).
   * Uses crypto.timingSafeEqual to prevent timing side-channel attacks.
   */
  public static verifyPassword(password: string, storedHash: string): boolean {
    if (!password || !storedHash || !storedHash.includes(':')) {
      return false;
    }

    try {
      const [salt, keyHex] = storedHash.split(':');
      if (!salt || !keyHex) return false;

      const derivedKey = crypto.scryptSync(password, salt, 64);
      const targetKey = Buffer.from(keyHex, 'hex');

      if (derivedKey.length !== targetKey.length) {
        return false;
      }

      return crypto.timingSafeEqual(derivedKey, targetKey);
    } catch (err) {
      console.error('[AuthService] Error verifying password hash:', err);
      return false;
    }
  }

  /**
   * Signs a JWT with HS256 using AppConfig.auth.jwtSecret.
   */
  public static generateToken(user: { id: string; email: string; role: 'admin' | 'agent' | 'viewer' }): string {
    const secret = AppConfig.auth.jwtSecret;
    const now = Math.floor(Date.now() / 1000);
    const expiresInSeconds = (AppConfig.auth.tokenExpiresInHours || 8) * 3600;

    const header = { alg: 'HS256', typ: 'JWT' };
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      iat: now,
      exp: now + expiresInSeconds
    };

    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signatureInput = `${headerB64}.${payloadB64}`;

    const signatureB64 = crypto
      .createHmac('sha256', secret)
      .update(signatureInput)
      .digest('base64url');

    return `${signatureInput}.${signatureB64}`;
  }

  /**
   * Verifies a JWT token signature and expiration.
   */
  public static verifyToken(token: string): { valid: boolean; payload?: JwtPayload; error?: string } {
    if (!token || typeof token !== 'string') {
      return { valid: false, error: 'Token missing' };
    }

    const parts = token.trim().split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Malformed token structure' };
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    const secret = AppConfig.auth.jwtSecret;
    const expectedSignatureB64 = crypto
      .createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    // Timing safe compare signature
    const sigBuf = Buffer.from(signatureB64);
    const expectedBuf = Buffer.from(expectedSignatureB64);

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { valid: false, error: 'Invalid token signature' };
    }

    try {
      const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf-8');
      const payload: JwtPayload = JSON.parse(payloadJson);

      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) {
        return { valid: false, error: 'Token has expired' };
      }

      return { valid: true, payload };
    } catch (err) {
      return { valid: false, error: 'Failed to parse token payload' };
    }
  }

  /**
   * Parses standard HTTP Cookie header into a key-value record.
   */
  public static parseCookies(cookieHeader?: string): Record<string, string> {
    const list: Record<string, string> = {};
    if (!cookieHeader) return list;

    cookieHeader.split(';').forEach((cookie) => {
      const parts = cookie.split('=');
      if (parts.length >= 2) {
        const name = parts[0].trim();
        const val = parts.slice(1).join('=').trim();
        list[name] = decodeURIComponent(val);
      }
    });

    return list;
  }

  /**
   * Generates a Set-Cookie header string for the httpOnly token.
   */
  public static createHttpOnlyCookie(token: string, maxAgeSeconds = 8 * 3600): string {
    const isProd = process.env.NODE_ENV === 'production';
    const secureFlag = isProd ? '; Secure' : '';
    return `token=${token}; HttpOnly${secureFlag}; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
  }

  /**
   * Generates a Set-Cookie header string to clear/expire the cookie.
   */
  public static createLogoutCookie(): string {
    const isProd = process.env.NODE_ENV === 'production';
    const secureFlag = isProd ? '; Secure' : '';
    return `token=; HttpOnly${secureFlag}; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
}

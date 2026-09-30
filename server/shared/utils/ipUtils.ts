/**
 * server/shared/utils/ipUtils.ts
 * Reliable client IP extraction for Serverless / Vercel multi-proxy environments.
 * Complies with ISO/IEC 27034-1 & SSD (Refinamiento B).
 */

import { Request } from 'express';

export function getClientIp(req: Request): string {
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    const rawIp = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
    const clientIp = rawIp.split(',')[0].trim();
    if (clientIp) return clientIp;
  }

  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    const rawReal = Array.isArray(realIp) ? realIp[0] : realIp;
    if (rawReal.trim()) return rawReal.trim();
  }

  return req.socket.remoteAddress || '127.0.0.1';
}

/**
 * test_auth_phase1_suite.ts
 * Automated SQA Suite for Phase 1 Authentication & Security (ISO/IEC 27034-1).
 * Verifies:
 * 1. Password hashing (scrypt) & JWT Token Generation/HttpOnly Cookie flags.
 * 2. Dual Mode Authentication Middleware (Cookie vs. Bearer Header - Refinamiento A).
 * 3. Serverless Rate Limiting & Account Lockout (5 attempts / 15 min - Refinamiento B).
 */

import { AuthService } from './server/infrastructure/services/AuthService.js';
import { RateLimiterService } from './server/infrastructure/services/RateLimiterService.js';
import { requireAuth, authRateLimiter, AuthenticatedRequest } from './server/infrastructure/web/v2Router.js';
import { AppConfig } from './server/shared/config/AppConfig.js';
import { hashPassword } from './scripts/generateAdminCredentials.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${testName} - ${detail || 'Assertion failed'}`);
    failed++;
  }
}

async function runTestSuite() {
  console.log('===============================================================');
  console.log('🛡️ SUITE DE PRUEBAS FORENSES SQA — FASE 1: AUTENTICACIÓN Y SEGURIDAD');
  console.log('===============================================================\n');

  // Setup test environment
  const testPassword = 'SuperAdminSecretPass2026!';
  const { hash: testHash } = hashPassword(testPassword);
  
  // Set environment variables dynamically for testing
  process.env.ADMIN_EMAIL = 'admin@o3energy.mx';
  process.env.ADMIN_PASSWORD_HASH = testHash;
  process.env.JWT_SECRET = 'd41d8cd98f00b204e9800998ecf8427e36067756f700411b4efb4d24597b6f63';

  // --------------------------------------------------------------------------
  // TEST 1: SCRYPT HASHING, VERIFICATION & HTTPONLY COOKIES
  // --------------------------------------------------------------------------
  console.log('📋 ESCENARIO 1: Verificación de Contraseña y Banderas HttpOnly Cookie');
  
  const validPassResult = AuthService.verifyPassword(testPassword, testHash);
  assert(validPassResult, 'Verificación exitosa con contraseña correcta (scrypt)');

  const invalidPassResult = AuthService.verifyPassword('WrongPass123', testHash);
  assert(!invalidPassResult, 'Rechazo correcto de contraseña incorrecta');

  const testUser = { id: 'admin-1', email: 'admin@o3energy.mx', role: 'admin' as const };
  const token = AuthService.generateToken(testUser);
  assert(typeof token === 'string' && token.split('.').length === 3, 'Generación de token JWT HS256 con 3 partes de firma');

  const verification = AuthService.verifyToken(token);
  assert(verification.valid && verification.payload?.email === 'admin@o3energy.mx', 'Validación del token JWT firmado con HMAC-SHA256');

  const cookieHeader = AuthService.createHttpOnlyCookie(token);
  assert(cookieHeader.includes('HttpOnly'), 'Cookie contiene la bandera HttpOnly');
  assert(cookieHeader.includes('SameSite=Strict'), 'Cookie contiene la bandera SameSite=Strict');
  assert(cookieHeader.includes('Path=/'), 'Cookie restringida a Path=/');

  // --------------------------------------------------------------------------
  // TEST 2: MIDDLEWARE DUAL MODE (COOKIE VS. BEARER HEADER - REFINAMIENTO A)
  // --------------------------------------------------------------------------
  console.log('\n📋 ESCENARIO 2: Extraer Token en Modo Dual (Cookie HttpOnly vs Bearer Header)');

  // Test Cookie Mode (Frontend React)
  let reqCookie: any = { headers: { cookie: `token=${token}; dummy=123` } };
  let resCookie: any = { status: (code: number) => ({ json: (data: any) => ({ code, data }) }) };
  let nextCalledCookie = false;
  requireAuth(reqCookie as AuthenticatedRequest, resCookie as any, () => { nextCalledCookie = true; });
  assert(nextCalledCookie && reqCookie.user?.email === 'admin@o3energy.mx', 'Extracción exitosa desde Cookie HttpOnly (req.headers.cookie)');

  // Test Bearer Header Mode (API Clients / Webhooks)
  let reqHeader: any = { headers: { authorization: `Bearer ${token}` } };
  let resHeader: any = { status: (code: number) => ({ json: (data: any) => ({ code, data }) }) };
  let nextCalledHeader = false;
  requireAuth(reqHeader as AuthenticatedRequest, resHeader as any, () => { nextCalledHeader = true; });
  assert(nextCalledHeader && reqHeader.user?.email === 'admin@o3energy.mx', 'Extracción exitosa desde Header Authorization: Bearer');

  // Test Unauthenticated Request
  let reqUnauth: any = { headers: {} };
  let statusUnauth = 0;
  let resUnauth: any = { status: (code: number) => { statusUnauth = code; return { json: (data: any) => data }; } };
  let nextCalledUnauth = false;
  requireAuth(reqUnauth as AuthenticatedRequest, resUnauth as any, () => { nextCalledUnauth = true; });
  assert(!nextCalledUnauth && statusUnauth === 401, 'Rechazo HTTP 401 cuando no se provee ni Cookie ni Authorization Header');

  // --------------------------------------------------------------------------
  // TEST 3: RATE LIMITING PERSISTENTE & BLOQUEO (REFINAMIENTO B)
  // --------------------------------------------------------------------------
  console.log('\n📋 ESCENARIO 3: Rate Limiting de 5 intentos por IP con HTTP 429');

  RateLimiterService.clearMemoryStore();
  const attackerIp = '203.0.113.42';

  // Simular 5 intentos fallidos consecutivamente
  for (let i = 1; i <= 5; i++) {
    await RateLimiterService.registerFailedAttempt(attackerIp);
  }

  const rateLimitCheck = await RateLimiterService.checkRateLimit(attackerIp);
  assert(!rateLimitCheck.allowed, 'IP bloqueada tras alcanzar 5 intentos fallidos');
  assert(rateLimitCheck.resetInSeconds > 0, 'Cálculo dinámico de segundos restantes para desbloqueo');

  // Test Middleware blocking
  let reqBlocked: any = { headers: { 'x-forwarded-for': attackerIp }, socket: {} };
  let statusBlocked = 0;
  let jsonBlockedData: any = null;
  let resBlocked: any = {
    status: (code: number) => {
      statusBlocked = code;
      return { json: (data: any) => { jsonBlockedData = data; return data; } };
    }
  };
  let nextCalledBlocked = false;
  await authRateLimiter(reqBlocked as any, resBlocked as any, () => { nextCalledBlocked = true; });
  assert(!nextCalledBlocked && statusBlocked === 429, 'authRateLimiter responde con HTTP 429 Too Many Requests');
  assert(jsonBlockedData?.resetInSeconds > 0, 'Respuesta 429 incluye resetInSeconds para informar al usuario');

  // Test reset on successful login
  const legitIp = '203.0.113.99';
  await RateLimiterService.registerFailedAttempt(legitIp);
  await RateLimiterService.resetRateLimit(legitIp);
  const legitCheck = await RateLimiterService.checkRateLimit(legitIp);
  assert(legitCheck.allowed && legitCheck.remainingAttempts === 5, 'Reset de contador de Rate Limit tras inicio de sesión exitoso');

  // Summary
  console.log('\n===============================================================');
  console.log(`📊 RESULTADO DE LA SUITE SQA: ${passed} PRUEBAS PASADAS, ${failed} FALLADAS`);
  console.log('===============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Fatal error in SQA Test Suite:', err);
  process.exit(1);
});

/**
 * test_audit_log_phase3_suite.ts
 * Automated SQA Suite for Phase 3: Audit Log Dashboard, Pagination, IP Extraction & 30-Day Retention Purge.
 * Standardized under ISO/IEC 27034-1 & HRU / SSD (Rules 2, 6, 8).
 */

import { AuditLogService } from './server/infrastructure/services/AuditLogService.js';
import { InMemoryConversationRepository } from './server/infrastructure/persistence/Repositories.js';
import { getClientIp } from './server/shared/utils/ipUtils.js';
import { AuthService } from './server/infrastructure/services/AuthService.js';
import { requireRole } from './server/infrastructure/web/v2Router.js';

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

async function runPhase3TestSuite() {
  console.log('===============================================================');
  console.log('🛡️ SUITE DE PRUEBAS FORENSES SQA — FASE 3: BITÁCORA Y REFINAMIENTOS');
  console.log('===============================================================\n');

  const tenantId = 'o3energy_mexico';
  const adminEmail = 'admin@o3energy.mx';

  // --------------------------------------------------------------------------
  // TEST 1: REFINAMIENTO B — EXTRACCIÓN CONFIABLE DE IP EN SERVERLESS (VERCEL)
  // --------------------------------------------------------------------------
  console.log('📋 ESCENARIO 1: Extracción Confiable de IP (getClientIp con x-forwarded-for)');

  const mockReqProxy: any = {
    headers: { 'x-forwarded-for': '203.0.113.195, 10.0.0.1, 172.16.0.5' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const extractedIp = getClientIp(mockReqProxy);
  assert(extractedIp === '203.0.113.195', 'Extrae la IP pública real del cliente evitando la IP del balanceador de carga');

  const mockReqDirect: any = { headers: {}, socket: { remoteAddress: '198.51.100.22' } };
  assert(getClientIp(mockReqDirect) === '198.51.100.22', 'Fallback correcto a socket.remoteAddress si x-forwarded-for no está presente');

  // --------------------------------------------------------------------------
  // TEST 2: REFINAMIENTO C — PAGINACIÓN Y LÍMITES EN CONSULTAS DE AUDITORÍA
  // --------------------------------------------------------------------------
  console.log('\n📋 ESCENARIO 2: Paginación y Límites en Consultas (AuditLogService.getLogs)');

  AuditLogService.clearMemoryLogs();

  // Generate 65 mock audit logs
  for (let i = 1; i <= 65; i++) {
    await AuditLogService.logEvent({
      eventType: i % 2 === 0 ? 'CHAT_SOFT_DELETED' : 'CHAT_RESTORED',
      userEmail: adminEmail,
      userRole: 'admin',
      resourceId: `521550000${i.toString().padStart(4, '0')}`,
      tenantId,
      ipAddress: '203.0.113.195',
    });
  }

  const page1 = await AuditLogService.getLogs(tenantId, 1, 50);
  assert(page1.total === 65, 'Respuesta incluye el conteo total exacto de eventos (65)');
  assert(page1.totalPages === 2, 'Calcula correctamente totalPages (2 páginas)');
  assert(page1.data.length === 50, 'Página 1 devuelve exactamente 50 registros');
  assert(page1.page === 1 && page1.limit === 50, 'Metadatos de paginación devueltos correctamente');

  const page2 = await AuditLogService.getLogs(tenantId, 2, 50);
  assert(page2.data.length === 15, 'Página 2 devuelve los 15 registros restantes');

  // --------------------------------------------------------------------------
  // TEST 3: REFINAMIENTO A — LA VERDAD DE LOS 30 DÍAS (PURGA DE CHATS EXPIRADOS)
  // --------------------------------------------------------------------------
  console.log('\n📋 ESCENARIO 3: Purga de Chats Eliminados > 30 días (repo.purgeExpiredTrash)');

  const repo = new InMemoryConversationRepository();

  // Chat 1: Soft-deleted 40 days ago
  const oldPhone = '5215599990001';
  const oldConv = await repo.findByPhone(tenantId, oldPhone);
  oldConv.status = 'deleted';
  const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  oldConv.deletedAt = fortyDaysAgo;
  oldConv.deletedBy = adminEmail;
  await repo.save(oldConv);

  // Chat 2: Soft-deleted 10 days ago
  const recentPhone = '5215599990002';
  const recentConv = await repo.findByPhone(tenantId, recentPhone);
  recentConv.status = 'deleted';
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  recentConv.deletedAt = tenDaysAgo;
  recentConv.deletedBy = adminEmail;
  await repo.save(recentConv);

  const purgedCount = await repo.purgeExpiredTrash(tenantId, 30);
  assert(purgedCount === 1, 'Purga exactamente 1 chat archivado con antigüedad > 30 días');

  const trashedAfterPurge = await repo.findTrash(tenantId);
  assert(!trashedAfterPurge.some((c) => c.phone === oldPhone), 'El chat de hace 40 días fue eliminado físicamente');
  assert(trashedAfterPurge.some((c) => c.phone === recentPhone), 'El chat de hace 10 días se conserva intacto en la papelera');

  // --------------------------------------------------------------------------
  // TEST 4: SEGURIDAD Y RBAC EN ENDPOINTS DE AUDITORÍA
  // --------------------------------------------------------------------------
  console.log('\n📋 ESCENARIO 4: Protección RBAC de Endpoints de Auditoría y Purga');

  const agentUser = { id: 'usr-agent', email: 'agente@o3energy.mx', role: 'agent' as const };
  const agentReq: any = { user: AuthService.verifyToken(AuthService.generateToken(agentUser)).payload };

  let allowed = false;
  let statusCode = 0;
  const mockRes: any = {
    status: (code: number) => {
      statusCode = code;
      return { json: (d: any) => d };
    }
  };

  requireRole(['admin'])(agentReq, mockRes, () => { allowed = true; });
  assert(!allowed && statusCode === 403, 'Rechazo HTTP 403 al intentar acceder a la bitácora con rol "agent"');

  // Summary
  console.log('\n===============================================================');
  console.log(`📊 RESULTADO DE LA SUITE SQA FASE 3: ${passed} PRUEBAS PASADAS, ${failed} FALLADAS`);
  console.log('===============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase3TestSuite().catch((err) => {
  console.error('Fatal error in Phase 3 SQA Test Suite:', err);
  process.exit(1);
});

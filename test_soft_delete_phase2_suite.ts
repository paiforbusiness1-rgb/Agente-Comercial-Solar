/**
 * test_soft_delete_phase2_suite.ts
 * Automated SQA Suite for Phase 2: Soft Delete, Trash View, RBAC, and Audit Logs.
 * Standardized under ISO/IEC 27034-1 & HRU / SSD (Rules 2, 6, 8).
 */

import { InMemoryConversationRepository } from './server/infrastructure/persistence/Repositories.js';
import { AuthService } from './server/infrastructure/services/AuthService.js';
import { AuditLogService } from './server/infrastructure/services/AuditLogService.js';
import { requireAuth, requireRole } from './server/infrastructure/web/v2Router.js';

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

async function runPhase2TestSuite() {
  console.log('===============================================================');
  console.log('🛡️ SUITE DE PRUEBAS FORENSES SQA — FASE 2: SOFT DELETE & RBAC');
  console.log('===============================================================\n');

  const repo = new InMemoryConversationRepository();
  const tenantId = 'o3energy_mexico';
  const testPhone = '5215512345678';
  const adminEmail = 'admin@o3energy.mx';
  const agentEmail = 'agente@o3energy.mx';

  AuditLogService.clearMemoryLogs();

  // Create initial chat
  const conv = await repo.findByPhone(tenantId, testPhone);
  conv.nombre = 'Prospecto Prueba SoftDelete';
  await repo.save(conv);

  // Verify chat is in active list
  let activeChats = await repo.findAll(tenantId);
  assert(activeChats.some((c) => c.phone === testPhone), 'Chat inicial está presente en lista de chats activos');

  // --------------------------------------------------------------------------
  // TEST 1: SOFT DELETE OPERATION & NON-DESTRUCTION OF DATA
  // --------------------------------------------------------------------------
  console.log('\n📋 ESCENARIO 1: Ejecución de Soft Delete (status: deleted, deletedAt, deletedBy)');

  const deleteSuccess = await repo.softDelete(tenantId, testPhone, adminEmail);
  assert(deleteSuccess, 'Ejecución exitosa de repo.softDelete()');

  // Register audit log
  await AuditLogService.logEvent({
    eventType: 'CHAT_SOFT_DELETED',
    userEmail: adminEmail,
    userRole: 'admin',
    resourceId: testPhone,
    tenantId,
    details: { action: 'Soft delete test' },
  });

  activeChats = await repo.findAll(tenantId);
  assert(!activeChats.some((c) => c.phone === testPhone), 'Chat eliminado suavemente YA NO aparece en la lista de activos');

  const rawConv = await repo.findByPhone(tenantId, testPhone);
  assert(rawConv.status === 'deleted', 'El campo status del documento cambia a "deleted"');
  assert(typeof rawConv.deletedAt === 'string', 'El campo deletedAt registra timestamp ISO');
  assert(rawConv.deletedBy === adminEmail, `El campo deletedBy registra al usuario (${adminEmail})`);

  // --------------------------------------------------------------------------
  // TEST 2: VISTA DE PAPELERA DE RECICLAJE (TRASH VIEW)
  // --------------------------------------------------------------------------
  console.log('\n📋 ESCENARIO 2: Consulta de Conversaciones en Papelera (findTrash)');

  const trashedChats = await repo.findTrash(tenantId);
  assert(trashedChats.some((c) => c.phone === testPhone), 'El chat archivado aparece correctamente en la consulta findTrash()');

  // --------------------------------------------------------------------------
  // TEST 3: RBAC AUTHORIZATION CONTROL (SOLO ADMIN PUEDE ELIMINAR)
  // --------------------------------------------------------------------------
  console.log('\n📋 ESCENARIO 3: Control de Acceso por Roles (RBAC - requireRole)');

  const adminUser = { id: 'usr-1', email: adminEmail, role: 'admin' as const };
  const agentUser = { id: 'usr-2', email: agentEmail, role: 'agent' as const };

  const adminToken = AuthService.generateToken(adminUser);
  const agentToken = AuthService.generateToken(agentUser);

  // Mock requests
  const adminReq: any = { user: AuthService.verifyToken(adminToken).payload };
  const agentReq: any = { user: AuthService.verifyToken(agentToken).payload };

  let adminAllowed = false;
  requireRole(['admin'])(adminReq, {} as any, () => { adminAllowed = true; });
  assert(adminAllowed, 'Usuario con rol "admin" es APROBADO por requireRole(["admin"])');

  let agentAllowed = false;
  let forbiddenStatusCode = 0;
  const agentRes: any = {
    status: (code: number) => {
      forbiddenStatusCode = code;
      return { json: (d: any) => d };
    }
  };
  requireRole(['admin'])(agentReq, agentRes, () => { agentAllowed = true; });
  assert(!agentAllowed && forbiddenStatusCode === 403, 'Usuario con rol "agent" es RECHAZADO con HTTP 403 al intentar eliminar');

  // --------------------------------------------------------------------------
  // TEST 4: RESTAURACIÓN DE CONVERSACIÓN DESDE LA PAPELERA
  // --------------------------------------------------------------------------
  console.log('\n📋 ESCENARIO 4: Restauración de Chat (repo.restore)');

  const restoreSuccess = await repo.restore(tenantId, testPhone);
  assert(restoreSuccess, 'Ejecución exitosa de repo.restore()');

  await AuditLogService.logEvent({
    eventType: 'CHAT_RESTORED',
    userEmail: adminEmail,
    userRole: 'admin',
    resourceId: testPhone,
    tenantId,
    details: { action: 'Restore test' },
  });

  activeChats = await repo.findAll(tenantId);
  assert(activeChats.some((c) => c.phone === testPhone), 'El chat restaurado vuelve a aparecer en la lista de activos');

  const trashedAfterRestore = await repo.findTrash(tenantId);
  assert(!trashedAfterRestore.some((c) => c.phone === testPhone), 'El chat restaurado desaparece de la Papelera de Reciclaje');

  // --------------------------------------------------------------------------
  // TEST 5: TRAZABILIDAD E INMUTABILIDAD EN LA BITÁCORA (AUDIT LOGS)
  // --------------------------------------------------------------------------
  console.log('\n📋 ESCENARIO 5: Registro Inmutable en AuditLogService (Regla 8)');

  const logsRes = await AuditLogService.getLogs(tenantId);
  const logs = logsRes.data;
  assert(logs.length >= 2, 'Se generaron 2 registros de auditoría durante el ciclo de vida');
  
  const deleteLog = logs.find((l) => l.eventType === 'CHAT_SOFT_DELETED');
  assert(!!deleteLog && deleteLog.userEmail === adminEmail && deleteLog.resourceId === testPhone, 'Evento CHAT_SOFT_DELETED registrado con email y teléfono correctos');

  const restoreLog = logs.find((l) => l.eventType === 'CHAT_RESTORED');
  assert(!!restoreLog && restoreLog.userEmail === adminEmail && restoreLog.resourceId === testPhone, 'Evento CHAT_RESTORED registrado con email y teléfono correctos');

  // Summary
  console.log('\n===============================================================');
  console.log(`📊 RESULTADO DE LA SUITE SQA FASE 2: ${passed} PRUEBAS PASADAS, ${failed} FALLADAS`);
  console.log('===============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase2TestSuite().catch((err) => {
  console.error('Fatal error in Phase 2 SQA Test Suite:', err);
  process.exit(1);
});

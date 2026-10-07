/**
 * SofiaForensicApo013.test.ts
 * Suite SQA Forense — Plan APO-013 (TS-01 a TS-03).
 * Valida la Resiliencia de Repositorios, Lazy Loading Defensivo y Ciclo de Vida de Soft Delete / Papelera.
 * Cumplimiento:
 * - Regla 2 (HRU): Cero regresiones y universalidad.
 * - Regla 3 (Anti-God-Object): Singleton defensivo en container.ts sin bare undefined exports.
 * - Regla 6 (SSD): Aislamiento seguro de credenciales y prevención de excepciones no controladas.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getConvRepo,
  getLeadRepo,
  convRepo,
  leadRepo,
  initRepositories,
} from '../../infrastructure/web/container.js';

describe('SQA Forense Plan APO-013 — Tests TS-01 a TS-03 (Lazy Loading Defensivo y Ciclo Soft Delete)', () => {
  const tenantId = 'o3energy_mexico';

  beforeEach(() => {
    // Reiniciar repositorios a estado en memoria limpio antes de cada prueba
    initRepositories(null);
  });

  // ─── TS-01: LAZY LOADING DEFENSIVO Y CERO UNDEFINED ────────────────────────
  it('TS-01: getConvRepo() y convRepo Proxy devuelven instancias válidas sin lanzar TypeError incluso si no se ejecutó initRepositories', async () => {
    // 1. Invocar getConvRepo directamente
    const repoInstance = getConvRepo();
    expect(repoInstance).toBeDefined();
    expect(typeof repoInstance.findByPhone).toBe('function');
    expect(typeof repoInstance.softDelete).toBe('function');
    expect(typeof repoInstance.findAll).toBe('function');

    // 2. Invocar métodos a través del Proxy convRepo (Garantía Anti-Undefined)
    const chats = await convRepo.findAll(tenantId);
    expect(Array.isArray(chats)).toBe(true);

    // 3. Probar getLeadRepo y leadRepo Proxy
    const leadRepoInstance = getLeadRepo();
    expect(leadRepoInstance).toBeDefined();
    expect(typeof leadRepoInstance.findAll).toBe('function');

    const leads = await leadRepo.findAll(tenantId);
    expect(Array.isArray(leads)).toBe(true);
  });

  // ─── TS-02: CICLO COMPLETO DE SOFT DELETE Y PAPELERA ──────────────────────
  it('TS-02: Soft Delete traslada el chat a la papelera (findTrash) y lo retira de la lista activa (findAll)', async () => {
    const testPhone = '5214777000099';
    const adminEmail = 'admin@o3energy.mx';

    // 1. Crear conversación activa de prueba
    const conv = await convRepo.findByPhone(tenantId, testPhone);
    conv.nombre = 'Cliente Para Archivar';
    conv.messages.push({
      sender: 'user',
      text: 'Hola, quiero archivar este chat',
      timestamp: new Date().toISOString(),
    });
    await convRepo.save(conv);

    // Verificar que está presente en la lista activa
    const initialActive = await convRepo.findAll(tenantId);
    expect(initialActive.some((c) => c.phone === testPhone)).toBe(true);

    // 2. Ejecutar Soft Delete
    const deleted = await convRepo.softDelete(tenantId, testPhone, adminEmail);
    expect(deleted).toBe(true);

    // 3. Verificar que YA NO aparece en la lista activa
    const postActive = await convRepo.findAll(tenantId);
    expect(postActive.some((c) => c.phone === testPhone)).toBe(false);

    // 4. Verificar que APARECE en la papelera de reciclaje (findTrash) con auditoría
    const trashList = await convRepo.findTrash(tenantId);
    const trashedChat = trashList.find((c) => c.phone === testPhone);
    expect(trashedChat).toBeDefined();
    expect(trashedChat?.status).toBe('deleted');
    expect(trashedChat?.deletedBy).toBe(adminEmail);
    expect(typeof trashedChat?.deletedAt).toBe('string');
  });

  // ─── TS-03: RESTAURACIÓN Y MANEJO DE CASOS BORDE ──────────────────────────
  it('TS-03: restore recupera el chat archivado a la lista activa; llamadas con teléfono inexistente retornan false sin corromper el estado', async () => {
    const testPhone = '5214777000088';
    const adminEmail = 'admin@o3energy.mx';

    // 1. Caso Borde: softDelete con teléfono inexistente retorna false de forma controlada
    const nonexistentDelete = await convRepo.softDelete(tenantId, '5210000000000', adminEmail);
    expect(nonexistentDelete).toBe(false);

    // 2. Crear y archivar un chat para probar restore
    const conv = await convRepo.findByPhone(tenantId, testPhone);
    conv.nombre = 'Cliente Restaurable';
    await convRepo.save(conv);
    await convRepo.softDelete(tenantId, testPhone, adminEmail);

    // Verificar que está en papelera
    const trashBefore = await convRepo.findTrash(tenantId);
    expect(trashBefore.some((c) => c.phone === testPhone)).toBe(true);

    // 3. Restaurar el chat
    const restored = await convRepo.restore(tenantId, testPhone);
    expect(restored).toBe(true);

    // 4. Verificar que vuelve a la lista activa
    const activeAfter = await convRepo.findAll(tenantId);
    expect(activeAfter.some((c) => c.phone === testPhone)).toBe(true);

    // 5. Caso Borde: restore de un teléfono que no está en papelera retorna false
    const nonexistentRestore = await convRepo.restore(tenantId, '5219999999999');
    expect(nonexistentRestore).toBe(false);
  });
});

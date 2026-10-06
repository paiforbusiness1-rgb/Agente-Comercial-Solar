/**
 * SyncPolicyService.test.ts
 * Suite SQA Forense — Plan APO-011 (T36 - T40).
 * Valida:
 * 1. T36: Background Zero-Traffic: Pestaña oculta (document.hidden) bloquea peticiones y aborta in-flight.
 * 2. T37: Auto-Sleep: Inactividad > 5 minutos detiene al 100% las peticiones al servidor.
 * 3. T38: Anti-Concurrencia: Peticiones concurrentes en vuelo (isFetching) se descartan sin saturar la red.
 * 4. T39: Wakeup Reactivo: Retorno a primer plano activa refresco inmediato solo si los datos están desactualizados.
 * 5. T40: Cadencia Restrictiva: Intervalo inferior al mínimo seguro (45s) es elevado automáticamente a 45s.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncPolicyService, SyncEvaluationContext } from '../../../src/services/SyncPolicyService.js';

describe('SQA Forense Plan APO-011 — Tests T36 a T40 (Zero-Spam Sync Policy)', () => {
  let policy: SyncPolicyService;

  beforeEach(() => {
    vi.restoreAllMocks();
    policy = new SyncPolicyService({
      intervalMs: 60000,
      idleTimeoutMs: 300000,
      minFreshnessMs: 15000,
      enableTelemetry: false, // Silenciar en tests
    });
  });

  // ─── T36: Background Zero-Traffic ─────────────────────────────────────────
  it('T36: Cuando la pestaña está en segundo plano (isVisible: false), bloquea la petición y manda abortar peticiones en vuelo', () => {
    const ctx: SyncEvaluationContext = {
      isVisible: false, // Simula document.hidden = true
      lastActivityMs: Date.now(),
      lastRefreshMs: 0,
      isFetching: false,
      currentTimeMs: Date.now(),
    };

    const decision = policy.shouldExecutePoll(ctx);

    expect(decision.shouldPoll).toBe(false);
    expect(decision.state).toBe('BACKGROUND');
    expect(decision.shouldAbortInFlight).toBe(true);
    expect(decision.reason).toContain('background');

    // Valida que el abort controller aborte efectivamente
    const controller = policy.createAbortController();
    const abortSpy = vi.spyOn(controller, 'abort');
    
    policy.abortCurrentRequest('Pestaña minimizada');
    expect(abortSpy).toHaveBeenCalled();
  });

  // ─── T37: Auto-Sleep por Inactividad ───────────────────────────────────────
  it('T37: Tras 5 minutos y 1 segundo sin interacción, el estado cambia a IDLE_SLEEP y suspende al 100% las peticiones', () => {
    const startTime = 1000000;
    const idleDuration = 300001; // 5 minutos y 1 milisegundo

    const ctx: SyncEvaluationContext = {
      isVisible: true,
      lastActivityMs: startTime,
      lastRefreshMs: startTime,
      isFetching: false,
      currentTimeMs: startTime + idleDuration,
    };

    const decision = policy.shouldExecutePoll(ctx);

    expect(decision.shouldPoll).toBe(false);
    expect(decision.state).toBe('IDLE_SLEEP');
    expect(decision.shouldAbortInFlight).toBe(true);
    expect(decision.reason).toContain('auto-sleep');
  });

  // ─── T38: Anti-Concurrencia (In-Flight Guard) ─────────────────────────────
  it('T38: Si hay una petición previa en curso (isFetching: true), el nuevo ciclo se descarta para evitar saturación', () => {
    const now = 2000000;
    const ctx: SyncEvaluationContext = {
      isVisible: true,
      lastActivityMs: now,
      lastRefreshMs: now - 90000, // Tiempo de intervalo cumplido
      isFetching: true,            // Pero la petición anterior sigue viva
      currentTimeMs: now,
    };

    const decision = policy.shouldExecutePoll(ctx);

    expect(decision.shouldPoll).toBe(false);
    expect(decision.reason).toContain('in-flight');
  });

  // ─── T39: Wakeup Reactivo Inmediato ───────────────────────────────────────
  it('T39: Al regresar a la pestaña, autoriza actualización inmediata si los datos superan el umbral de frescura (15s)', () => {
    const wakeupTime = 5000000;

    // Caso A: Datos con 30 segundos de antigüedad (> 15s umbral)
    const staleEvaluation = policy.evaluateWakeup(wakeupTime - 30000, wakeupTime);
    expect(staleEvaluation.shouldRefreshImmediately).toBe(true);
    expect(staleEvaluation.reason).toContain('Wakeup with stale data');

    // Caso B: Datos frescos de hace solo 5 segundos (< 15s umbral)
    const freshEvaluation = policy.evaluateWakeup(wakeupTime - 5000, wakeupTime);
    expect(freshEvaluation.shouldRefreshImmediately).toBe(false);
    expect(freshEvaluation.reason).toContain('Data still fresh');
  });

  // ─── T40: Cadencia Restrictiva y Floor de Seguridad ───────────────────────
  it('T40: Configurar un intervalo abusivo (ej. 2000ms o 3000ms) es rechazado y elevado al piso seguro de 45000ms', () => {
    const dangerousPolicy = new SyncPolicyService({
      intervalMs: 2000, // Intento de polling cada 2 segundos
    });

    // El piso de seguridad inamovible debe proteger a Vercel
    expect(dangerousPolicy.intervalMs).toBe(45000);
    expect(dangerousPolicy.intervalMs).toBeGreaterThanOrEqual(SyncPolicyService.MIN_SAFE_INTERVAL_MS);
  });
});

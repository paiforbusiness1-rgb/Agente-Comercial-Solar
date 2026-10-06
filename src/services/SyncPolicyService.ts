/**
 * SyncPolicyService.ts
 * Motor de Políticas de Sincronización Adaptativa (Zero-Spam Sync Policy)
 * Arquitectura Clean / Microservicio Desacoplado (Regla 3: Anti-God-Object)
 * Estándar HRU (Regla 2): Cero Hardcoding vía Variables de Entorno y Floor Seguro.
 * Seguridad SSD (Regla 6): Cancelación Activa vía AbortController y Anti-Concurrencia.
 */

export type SyncState = 'ACTIVE' | 'BACKGROUND' | 'IDLE_SLEEP';

export interface SyncPolicyConfig {
  intervalMs?: number;
  idleTimeoutMs?: number;
  minFreshnessMs?: number;
  enableTelemetry?: boolean;
}

export interface SyncEvaluationContext {
  isVisible: boolean;
  lastActivityMs: number;
  lastRefreshMs: number;
  isFetching: boolean;
  currentTimeMs?: number;
}

export interface PollDecision {
  shouldPoll: boolean;
  reason: string;
  state: SyncState;
  shouldAbortInFlight: boolean;
}

export class SyncPolicyService {
  public static readonly MIN_SAFE_INTERVAL_MS = 45000; // 45s Piso de seguridad inquebrantable
  public static readonly DEFAULT_INTERVAL_MS = 60000;   // 60s Cadencia activa por defecto
  public static readonly DEFAULT_IDLE_TIMEOUT_MS = 300000; // 5 minutos de inactividad
  public static readonly DEFAULT_MIN_FRESHNESS_MS = 15000; // 15s Umbral de datos frescos

  public readonly intervalMs: number;
  public readonly idleTimeoutMs: number;
  public readonly minFreshnessMs: number;
  public readonly enableTelemetry: boolean;

  private currentAbortController: AbortController | null = null;
  private lastReportedState: SyncState | null = null;

  constructor(config?: SyncPolicyConfig) {
    // Refinamiento 2 (HRU): Detección dinámica de variables de entorno con fallback seguro
    const envInterval = typeof process !== 'undefined' && process.env?.VITE_SYNC_INTERVAL_MS 
      ? Number(process.env.VITE_SYNC_INTERVAL_MS) 
      : typeof (import.meta as any)?.env !== 'undefined' && (import.meta as any).env?.VITE_SYNC_INTERVAL_MS
      ? Number((import.meta as any).env.VITE_SYNC_INTERVAL_MS)
      : undefined;

    const envIdle = typeof process !== 'undefined' && process.env?.VITE_IDLE_TIMEOUT_MS 
      ? Number(process.env.VITE_IDLE_TIMEOUT_MS) 
      : typeof (import.meta as any)?.env !== 'undefined' && (import.meta as any).env?.VITE_IDLE_TIMEOUT_MS
      ? Number((import.meta as any).env.VITE_IDLE_TIMEOUT_MS)
      : undefined;

    const requestedInterval = config?.intervalMs ?? envInterval ?? SyncPolicyService.DEFAULT_INTERVAL_MS;
    
    // T40: Piso inquebrantable de 45 segundos (Evita ataques o configuraciones abusivas de red)
    this.intervalMs = Math.max(requestedInterval, SyncPolicyService.MIN_SAFE_INTERVAL_MS);

    this.idleTimeoutMs = config?.idleTimeoutMs ?? envIdle ?? SyncPolicyService.DEFAULT_IDLE_TIMEOUT_MS;
    this.minFreshnessMs = config?.minFreshnessMs ?? SyncPolicyService.DEFAULT_MIN_FRESHNESS_MS;
    this.enableTelemetry = config?.enableTelemetry ?? true;
  }

  /**
   * Determina el estado del cliente según visibilidad e inactividad
   */
  public determineState(isVisible: boolean, lastActivityMs: number, currentTimeMs?: number): SyncState {
    if (!isVisible) {
      return 'BACKGROUND';
    }
    const now = currentTimeMs ?? Date.now();
    if (now - lastActivityMs >= this.idleTimeoutMs) {
      return 'IDLE_SLEEP';
    }
    return 'ACTIVE';
  }

  /**
   * Evalúa deterministamente si procede ejecutar una llamada de red
   */
  public shouldExecutePoll(ctx: SyncEvaluationContext): PollDecision {
    const now = ctx.currentTimeMs ?? Date.now();
    const state = this.determineState(ctx.isVisible, ctx.lastActivityMs, now);

    // T36: Pestaña en segundo plano / minimizada -> Cero peticiones y abortar peticiones activas
    if (!ctx.isVisible) {
      this.telemetryReport(state, 'Pestaña en segundo plano (0% peticiones)');
      return {
        shouldPoll: false,
        reason: 'Tab is in background (zero-traffic)',
        state: 'BACKGROUND',
        shouldAbortInFlight: true,
      };
    }

    // T38: Anti-Concurrencia -> Si hay una llamada previa en curso, se descarta silenciosamente
    if (ctx.isFetching) {
      return {
        shouldPoll: false,
        reason: 'Previous request still in-flight (anti-concurrency)',
        state,
        shouldAbortInFlight: false,
      };
    }

    // T37: Inactividad superada -> Auto-sleep para ahorrar cuota de Vercel
    if (state === 'IDLE_SLEEP') {
      this.telemetryReport(state, `Inactividad de usuario > ${Math.round(this.idleTimeoutMs / 60000)}min (0% peticiones)`);
      return {
        shouldPoll: false,
        reason: 'User idle timeout exceeded (auto-sleep)',
        state: 'IDLE_SLEEP',
        shouldAbortInFlight: true,
      };
    }

    // Control de Cadencia: Validar si ya transcurrió el intervalo mínimo
    const elapsedSinceLastRefresh = now - ctx.lastRefreshMs;
    if (ctx.lastRefreshMs > 0 && elapsedSinceLastRefresh < this.intervalMs) {
      return {
        shouldPoll: false,
        reason: `Cadence interval not reached (${Math.round((this.intervalMs - elapsedSinceLastRefresh) / 1000)}s remaining)`,
        state: 'ACTIVE',
        shouldAbortInFlight: false,
      };
    }

    // Autorizado
    this.telemetryReport(state, `Refrescando datos cada ${Math.round(this.intervalMs / 1000)}s`);
    return {
      shouldPoll: true,
      reason: 'Poll allowed by sync policy',
      state: 'ACTIVE',
      shouldAbortInFlight: false,
    };
  }

  /**
   * T39: Evalúa si al despertar (volver a primer plano o interactuar) se debe hacer un fetch inmediato
   */
  public evaluateWakeup(lastRefreshMs: number, currentTimeMs?: number): { shouldRefreshImmediately: boolean; reason: string } {
    const now = currentTimeMs ?? Date.now();
    const elapsed = now - lastRefreshMs;

    if (lastRefreshMs === 0 || elapsed >= this.minFreshnessMs) {
      return {
        shouldRefreshImmediately: true,
        reason: `Wakeup with stale data (${Math.round(elapsed / 1000)}s old >= ${Math.round(this.minFreshnessMs / 1000)}s threshold)`,
      };
    }

    return {
      shouldRefreshImmediately: false,
      reason: `Data still fresh (${Math.round(elapsed / 1000)}s old < ${Math.round(this.minFreshnessMs / 1000)}s threshold)`,
    };
  }

  // ─── Gestión de AbortController (Refinamiento 1 - SSD) ───────────────────

  public createAbortController(): AbortController {
    this.abortCurrentRequest('Nueva petición iniciada');
    this.currentAbortController = new AbortController();
    return this.currentAbortController;
  }

  public getAbortSignal(): AbortSignal | undefined {
    return this.currentAbortController?.signal;
  }

  public abortCurrentRequest(reason: string = 'Cancelación solicitada'): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort(reason);
      this.currentAbortController = null;
      if (this.enableTelemetry) {
        console.info(`🔴 [SyncPolicy] Petición cancelada (AbortController): ${reason}`);
      }
    }
  }

  // ─── Telemetría de Estado (Refinamiento 3 - U-First) ──────────────────────

  public logManualSync(): void {
    if (this.enableTelemetry) {
      console.info('🔵 [SyncPolicy] Sync Forzado: Usuario solicitó actualización manual.');
    }
  }

  private telemetryReport(state: SyncState, detail: string): void {
    if (!this.enableTelemetry || this.lastReportedState === state) return;
    this.lastReportedState = state;

    if (state === 'ACTIVE') {
      console.info(`🟢 [SyncPolicy] Sync Activo: ${detail}`);
    } else if (state === 'BACKGROUND' || state === 'IDLE_SLEEP') {
      console.info(`🟡 [SyncPolicy] Sync en Reposo: ${detail}`);
    }
  }
}

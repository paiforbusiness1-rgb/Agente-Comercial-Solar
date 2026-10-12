/**
 * LLMCircuitBreaker.ts — Microservicio de Circuit Breaker para Proveedores de IA
 * 
 * Implementación de Máquina de Estados Finita (FSM) de 3 Estados:
 * - CLOSED: Tráfico normal hacia el proveedor. Monitoreo de latencia y fallas.
 * - OPEN: Proveedor bloqueado tras N fallas consecutivas. Fail-fast a 0ms sin consumir timeouts.
 * - HALF_OPEN: Cooldown expirado. Permite una única sonda de prueba. Si triunfa -> CLOSED; si falla -> OPEN.
 * 
 * Reglas Persistentes:
 * - Regla 2 (HRU): Cero hardcoding, tipado estricto, universalidad total.
 * - Regla 3 (Anti-God-Object): Microservicio desacoplado con responsabilidad única.
 * - Regla 4 (U-First): Respuesta inmediata y sin bloqueos de red hacia el usuario final.
 * - Regla 6 (SSD): Observabilidad de fallos sin exponer credenciales ni datos sensibles.
 */

import { logger } from '../../shared/logger/ConsoleLogger.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  name: string;
  failureThreshold?: number; // Número de fallas consecutivas para disparar (default: 2)
  cooldownMs?: number;       // Tiempo de reposo en estado OPEN antes de probar HALF_OPEN (default: 60,000 ms)
}

export class LLMCircuitBreaker {
  public readonly name: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  constructor(config: CircuitBreakerConfig) {
    this.name = config.name;
    this.failureThreshold = config.failureThreshold ?? 2;
    this.cooldownMs = config.cooldownMs ?? 60000;
  }

  public getState(): CircuitState {
    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.cooldownMs) {
        this.state = 'HALF_OPEN';
        logger.info(`[CircuitBreaker:${this.name}] Cooldown de ${this.cooldownMs}ms expirado. Transición a HALF_OPEN para sonda.`);
      }
    }
    return this.state;
  }

  public isOpen(): boolean {
    return this.getState() === 'OPEN';
  }

  public isAvailable(): boolean {
    const s = this.getState();
    return s === 'CLOSED' || s === 'HALF_OPEN';
  }

  public recordSuccess(): void {
    if (this.state !== 'CLOSED') {
      logger.info(`[CircuitBreaker:${this.name}] Sonda exitosa. Circuito restablecido a CLOSED.`);
    }
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
  }

  public recordFailure(err?: any): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    logger.warn(`[CircuitBreaker:${this.name}] Falla registrada (#${this.consecutiveFailures}/${this.failureThreshold})`, {
      error: err?.message || String(err),
      state: this.state,
    });

    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'OPEN';
      logger.error(`[CircuitBreaker:${this.name}] UMBRAL ALCANZADO. Circuito pasa a OPEN. Desvío proactivo activado por ${this.cooldownMs}ms.`);
    }
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
  }
}

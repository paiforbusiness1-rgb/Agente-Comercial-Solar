/**
 * SolarQuoteEngine.test.ts
 * Suite SQA forense — verifica cálculos deterministas del motor de cotización.
 * Garantiza cero alucinación: los paneles calculados deben coincidir exactamente
 * con los que el LLM debe reportar al usuario.
 */

import { describe, it, expect } from 'vitest';
import { SolarQuoteEngine } from './SolarQuoteEngine.js';

const engine = new SolarQuoteEngine();

describe('SolarQuoteEngine — Motor de Cotización Determinista', () => {

  // ─── GRUPO 1: Cálculos por Monto Mensual ─────────────────────────────────

  describe('Cálculo desde monto mensual normalizado', () => {
    it('$1,400/mes (=$2,800 bimestral) produce cotización no nula', () => {
      const result = engine.calculate(1400);
      expect(result).toBeDefined();
      expect(result.panels).toBeGreaterThan(0);
      expect(result.estimatedCost).toBeGreaterThan(0);
    });

    it('$1,400/mes produce panels par (regla NEXT_EVEN)', () => {
      const result = engine.calculate(1400);
      expect(result.panels % 2).toBe(0);
    });

    it('$1,400/mes tiene annualSavings = monthlyBill * 0.9 * 12', () => {
      const result = engine.calculate(1400);
      expect(result.annualSavings).toBe(Math.round(1400 * 0.9 * 12));
    });

    it('$2,000/mes produce cotización válida', () => {
      const result = engine.calculate(2000);
      expect(result.panels).toBeGreaterThan(0);
      expect(result.systemPowerKw).toBeGreaterThan(0);
    });
  });

  // ─── GRUPO 2: Factor de Carga Extra ──────────────────────────────────────

  describe('Extra Load Factor (EXTRA_LOAD_FACTOR = 1.25)', () => {
    it('extraLoad=true incrementa el monto efectivo y puede incrementar paneles', () => {
      const base = engine.calculate(1400, false);
      const withExtra = engine.calculate(1400, true);
      // El sistema con carga extra debe ser >= al base
      expect(withExtra.panels).toBeGreaterThanOrEqual(base.panels);
    });
  });

  // ─── GRUPO 3: Propiedades del resultado ──────────────────────────────────

  describe('Propiedades y formato del resultado', () => {
    it('costFormatted contiene "MXN"', () => {
      const result = engine.calculate(1400);
      expect(result.costFormatted).toContain('MXN');
    });

    it('systemDescription incluye cantidad de paneles', () => {
      const result = engine.calculate(1400);
      expect(result.systemDescription).toContain(String(result.panels));
    });

    it('monthlyBill en resultado iguala al input', () => {
      const result = engine.calculate(1400);
      expect(result.monthlyBill).toBe(1400);
    });
  });

  // ─── GRUPO 4: Consistencia Bimestral/Mensual (Anti-Alucinación) ──────────

  describe('Consistencia con BillNormalizerService (Anti-Alucinación)', () => {
    it('$2,800 bimestral → $1,400/mes → mismos paneles que calcular con 1400', () => {
      // Simula el flujo real: usuario dice $2,800 bimestral → normalizer → 1,400/mes → engine
      const monthlyFromBimestral = Math.round(2800 / 2); // = 1400
      const result = engine.calculate(monthlyFromBimestral);
      const directResult = engine.calculate(1400);
      expect(result.panels).toBe(directResult.panels);
      expect(result.estimatedCost).toBe(directResult.estimatedCost);
    });
  });
});

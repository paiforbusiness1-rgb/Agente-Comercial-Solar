/**
 * BillNormalizerService.test.ts
 * Suite SQA forense — verifica normalización bimestral/mensual,
 * pre-parseo determinista, defaults inteligentes y cero alucinación numérica.
 */

import { describe, it, expect } from 'vitest';
import { BillNormalizerService } from './BillNormalizerService.js';

describe('BillNormalizerService — Normalización de Recibos CFE', () => {

  // ─── GRUPO 1: Recibo Bimestral ────────────────────────────────────────────

  describe('Recibo Bimestral Explícito', () => {
    it('convierte $2,800 bimestral → $1,400 mensual', () => {
      const result = BillNormalizerService.normalize({
        rawAmount: 2800,
        rawFrequency: 'bimestral',
      });
      expect(result).not.toBeNull();
      expect(result!.monthlyBill).toBe(1400);
      expect(result!.bimestralBill).toBe(2800);
      expect(result!.frequency).toBe('bimestral');
      expect(result!.isDefaultFrequencyAssumed).toBe(false);
    });

    it('formattedSummary incluye desglose bimestral y mensual', () => {
      const result = BillNormalizerService.normalize({
        rawAmount: 3200,
        rawFrequency: 'bimestral',
      });
      expect(result!.formattedSummary).toContain('3,200');
      expect(result!.formattedSummary).toContain('1,600');
    });
  });

  // ─── GRUPO 2: Recibo Mensual ──────────────────────────────────────────────

  describe('Recibo Mensual Explícito', () => {
    it('convierte $1,400 mensual → $2,800 bimestral', () => {
      const result = BillNormalizerService.normalize({
        rawAmount: 1400,
        rawFrequency: 'mensual',
      });
      expect(result!.monthlyBill).toBe(1400);
      expect(result!.bimestralBill).toBe(2800);
      expect(result!.frequency).toBe('mensual');
    });
  });

  // ─── GRUPO 3: Default Inteligente (sin frecuencia → bimestral) ───────────

  describe('Default Inteligente CFE Residencial', () => {
    it('asigna frecuencia bimestral por defecto cuando no se especifica', () => {
      const result = BillNormalizerService.normalize({ rawAmount: 2800 });
      expect(result!.frequency).toBe('bimestral');
      expect(result!.isDefaultFrequencyAssumed).toBe(true);
      expect(result!.monthlyBill).toBe(1400);
    });
  });

  // ─── GRUPO 4: Pre-Parseo Determinista desde Texto ─────────────────────────

  describe('preParseUserText — Pre-Parseo de Mensajes', () => {
    it('extrae $2,800 bimestral desde "El monto es de 2800 pesos al bimestre"', () => {
      const result = BillNormalizerService.preParseUserText('El monto es de 2800 pesos al bimestre');
      expect(result).not.toBeNull();
      expect(result!.amount).toBe(2800);
      expect(result!.frequency).toBe('bimestral');
    });

    it('extrae $1,500 mensual desde "pago 1500 al mes"', () => {
      const result = BillNormalizerService.preParseUserText('pago 1500 al mes');
      expect(result!.amount).toBe(1500);
      expect(result!.frequency).toBe('mensual');
    });

    it('extrae monto sin frecuencia desde "mi recibo es de 3500"', () => {
      const result = BillNormalizerService.preParseUserText('mi recibo es de 3500');
      expect(result!.amount).toBe(3500);
      expect(result!.frequency).toBeUndefined();
    });

    it('retorna null para texto sin monto numérico', () => {
      const result = BillNormalizerService.preParseUserText('hola buenos días');
      expect(result).toBeNull();
    });

    it('maneja formato con comas: "pago $2,800 bimestrales"', () => {
      const result = BillNormalizerService.preParseUserText('pago $2,800 bimestrales');
      expect(result!.amount).toBe(2800);
      expect(result!.frequency).toBe('bimestral');
    });
  });

  // ─── GRUPO 5: normalize() con messageText como fallback ──────────────────

  describe('normalize() con messageText fallback', () => {
    it('extrae datos del texto cuando rawAmount es null', () => {
      const result = BillNormalizerService.normalize({
        rawAmount: null,
        messageText: 'mi recibo bimestral es de 2800 pesos',
      });
      expect(result).not.toBeNull();
      expect(result!.monthlyBill).toBe(1400);
      expect(result!.bimestralBill).toBe(2800);
    });
  });

  // ─── GRUPO 6: Casos Límite ────────────────────────────────────────────────

  describe('Casos Límite y Guardianes', () => {
    it('retorna null cuando amount es 0', () => {
      const result = BillNormalizerService.normalize({ rawAmount: 0 });
      expect(result).toBeNull();
    });

    it('retorna null cuando amount es negativo', () => {
      const result = BillNormalizerService.normalize({ rawAmount: -500 });
      expect(result).toBeNull();
    });

    it('retorna null cuando no hay monto ni texto parseable', () => {
      const result = BillNormalizerService.normalize({ rawAmount: null, messageText: 'hola!' });
      expect(result).toBeNull();
    });

    it('parseFrequency reconoce variante "bimestral" en minúsculas', () => {
      const result = BillNormalizerService.normalize({
        rawAmount: 3000,
        rawFrequency: 'BIMESTRAL',
      });
      expect(result!.frequency).toBe('bimestral');
    });
  });
});

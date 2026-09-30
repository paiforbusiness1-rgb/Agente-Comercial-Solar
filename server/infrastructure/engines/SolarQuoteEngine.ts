import { IQuoteEngine, QuoteResult } from '../../interfaces/IQuoteEngine.js';
import pricingMatrix from '../../shared/config/pricingMatrix.json';

export interface PriceTierConfig {
  minBimestralBill: number;
  maxBimestralBill: number;
  minMonthlyBill: number;
  maxMonthlyBill: number;
  panels: number;
  systemKwp: number;
  priceMxn: number;
  roiYears: number;
  rangeLabel: string;
}

export interface PricingMatrixConfig {
  currency: string;
  taxIncluded: boolean;
  defaultRoiYears: number;
  roundingRule: string;
  disclaimer: string;
  panelPowerW: number;
  tiers: PriceTierConfig[];
}

const matrix = pricingMatrix as unknown as PricingMatrixConfig;
const EXTRA_LOAD_FACTOR = 1.25;

export class SolarQuoteEngine implements IQuoteEngine {
  calculate(monthlyBillMxn: number, extraLoad = false): QuoteResult {
    const effectiveMonthlyBill = extraLoad
      ? monthlyBillMxn * EXTRA_LOAD_FACTOR
      : monthlyBillMxn;

    const bimestralBillEquivalent = effectiveMonthlyBill * 2;

    // Match tier based on bimestral bill equivalent
    const tier =
      matrix.tiers.find(
        (t) =>
          bimestralBillEquivalent >= t.minBimestralBill &&
          bimestralBillEquivalent < t.maxBimestralBill
      ) ?? matrix.tiers[matrix.tiers.length - 1];

    let panels = tier.panels;
    // Apply rounding rule if necessary (e.g. ensure even panel count)
    if (matrix.roundingRule === 'NEXT_EVEN' && panels % 2 !== 0) {
      panels += 1;
    }

    const systemPowerKw = tier.systemKwp;
    const estimatedCost = tier.priceMxn;
    const roiYears = tier.roiYears || matrix.defaultRoiYears;

    // Savings estimation (approx 90% bill offset)
    const annualSavings = Math.round(monthlyBillMxn * 0.90 * 12);
    const monthlySavings = Math.round(annualSavings / 12);

    return {
      monthlyBill: monthlyBillMxn,
      panels,
      systemPowerKw,
      estimatedCost,
      roiYears,
      monthlySavings,
      annualSavings,
      monthlySavingsFormatted: `$${monthlySavings.toLocaleString('es-MX')} MXN`,
      annualSavingsFormatted: `$${annualSavings.toLocaleString('es-MX')} MXN`,
      costFormatted: `$${estimatedCost.toLocaleString('es-MX')} MXN (IVA incluido)`,
      systemDescription: `${panels} paneles solares de alta eficiencia (${systemPowerKw.toFixed(1)} kWp)`,
      disclaimer: matrix.disclaimer,
    };
  }
}

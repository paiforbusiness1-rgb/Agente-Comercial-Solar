/**
 * BillNormalizerService.ts
 * Microservice following SOLID and Anti-God-Object architecture.
 * Encapsulates CFE electricity bill amount & frequency normalization,
 * bimestral to monthly calculations, smart defaults (residential bimestral CFE),
 * and pre-parsing heuristics for zero-latency single-pass LLM prompt context seeding.
 */

export interface BillInput {
  rawAmount?: number | null;
  rawFrequency?: 'bimestral' | 'mensual' | string | null;
  messageText?: string;
}

export interface NormalizationResult {
  monthlyBill: number;
  bimestralBill: number;
  frequency: 'bimestral' | 'mensual';
  isDefaultFrequencyAssumed: boolean;
  formattedSummary: string;
}

export class BillNormalizerService {
  /**
   * Normalizes bill amount and frequency.
   * If frequency is omitted, defaults to 'bimestral' (standard CFE residential billing in Mexico).
   */
  public static normalize(input: BillInput): NormalizationResult | null {
    let amount = input.rawAmount;
    let frequency = this.parseFrequency(input.rawFrequency);

    // If no raw amount provided, attempt pre-parsing from message text
    if ((!amount || amount <= 0) && input.messageText) {
      const preParsed = this.preParseUserText(input.messageText);
      if (preParsed) {
        amount = preParsed.amount;
        if (!frequency && preParsed.frequency) {
          frequency = preParsed.frequency;
        }
      }
    }

    if (!amount || amount <= 0) {
      return null;
    }

    let isDefaultAssumed = false;
    if (!frequency) {
      frequency = 'bimestral'; // Standard CFE residential default
      isDefaultAssumed = true;
    }

    let monthlyBill: number;
    let bimestralBill: number;

    if (frequency === 'bimestral') {
      bimestralBill = amount;
      monthlyBill = Math.round(amount / 2);
    } else {
      monthlyBill = amount;
      bimestralBill = Math.round(amount * 2);
    }

    const formattedSummary = frequency === 'bimestral'
      ? `$${bimestralBill.toLocaleString('es-MX')} MXN bimestrales ($${monthlyBill.toLocaleString('es-MX')} MXN/mes)`
      : `$${monthlyBill.toLocaleString('es-MX')} MXN mensuales ($${bimestralBill.toLocaleString('es-MX')} MXN/bimestre)`;

    return {
      monthlyBill,
      bimestralBill,
      frequency,
      isDefaultFrequencyAssumed: isDefaultAssumed,
      formattedSummary,
    };
  }

  /**
   * Pre-parses raw message text to extract numeric amounts and frequency keywords
   * before LLM invocation for single-pass prompt seeding.
   */
  public static preParseUserText(text: string): { amount: number; frequency?: 'bimestral' | 'mensual' } | null {
    if (!text) return null;

    const lower = text.toLowerCase().trim();

    // Match patterns like "$2,800 al bimestre", "2800 pesos bimestrales", "pago 2800 al mes", "2800 cada 2 meses"
    const cleanedText = lower.replace(/,/g, '');
    const amountMatch = cleanedText.match(/(?:pago|monto|recibo|es de|son|\$)?\s*(\d{3,6})\s*(?:pesos|mxn)?/);

    if (!amountMatch) return null;

    const amount = parseInt(amountMatch[1], 10);
    if (isNaN(amount) || amount <= 0) return null;

    let frequency: 'bimestral' | 'mensual' | undefined;

    if (
      lower.includes('bimestre') ||
      lower.includes('bimestral') ||
      lower.includes('cada dos meses') ||
      lower.includes('cada 2 meses') ||
      lower.includes('bimensual')
    ) {
      frequency = 'bimestral';
    } else if (
      lower.includes('mes') ||
      lower.includes('mensual') ||
      lower.includes('al mes') ||
      lower.includes('cada mes')
    ) {
      frequency = 'mensual';
    }

    return { amount, frequency };
  }

  private static parseFrequency(rawFreq?: string | null): 'bimestral' | 'mensual' | undefined {
    if (!rawFreq) return undefined;
    const lower = rawFreq.toLowerCase();
    if (lower.includes('bimest')) return 'bimestral';
    if (lower.includes('mens')) return 'mensual';
    return undefined;
  }
}

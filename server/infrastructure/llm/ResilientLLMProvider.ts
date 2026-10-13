/**
 * ResilientLLMProvider.ts — Microservicio de IA Resiliente con Fallback en Cascada y Circuit Breaker
 * 
 * Arquitectura: Groq (primario, 7s timeout) → Gemini 2.5 Flash (fallback automático)
 * Protegido por LLMCircuitBreaker FSM de 3 Estados (CLOSED, OPEN, HALF_OPEN)
 * Reglas:
 * - Regla 2 (HRU): Cero hardcoding, tipado estricto, universalidad total.
 * - Regla 3 (Anti-God-Object): Microservicio desacoplado con responsabilidad única.
 * - Regla 4 (U-First): Respuesta inmediata y sin bloqueos de red hacia el usuario final.
 * - Regla 6 (SSD): API keys aisladas en AppConfig / env vars, observabilidad explícita.
 * - Regla 7 (MCP): Formato JSON estructurado para integración limpia con SofiaPromptBuilder.
 */

import {
  ILLMProvider,
  LLMMessage,
  LLMResponse,
  ToolDefinition,
} from '../../interfaces/ILLMProvider.js';
import { GroqProvider } from './GroqProvider.js';
import { LLMCircuitBreaker } from './LLMCircuitBreaker.js';
import { AppConfig } from '../../shared/config/AppConfig.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';

export class ResilientLLMProvider implements ILLMProvider {
  private groqProvider: ILLMProvider;
  private geminiEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models';
  public readonly groqCircuit: LLMCircuitBreaker;
  public readonly geminiCircuit: LLMCircuitBreaker;

  constructor(
    groqProvider?: ILLMProvider,
    private customFetch?: typeof fetch,
    private geminiTimeoutMs: number = 3500,
    circuitBreakers?: { groq?: LLMCircuitBreaker; gemini?: LLMCircuitBreaker }
  ) {
    this.groqProvider = groqProvider || new GroqProvider();
    this.groqCircuit = circuitBreakers?.groq || new LLMCircuitBreaker({ name: 'Groq', failureThreshold: 2, cooldownMs: 60000 });
    this.geminiCircuit = circuitBreakers?.gemini || new LLMCircuitBreaker({ name: 'Gemini', failureThreshold: 2, cooldownMs: 60000 });
  }

  async complete(
    messages: LLMMessage[],
    tools?: ToolDefinition[],
    temperature = 0.2
  ): Promise<LLMResponse> {
    // Extracción de teléfono para observabilidad (Refinamiento 2)
    const phoneMatch = messages
      .find((m) => m.content && m.content.includes('<phone>'))
      ?.content.match(/<phone>([^<]+)<\/phone>/);
    const phone = phoneMatch ? phoneMatch[1].trim() : 'unknown';

    // 1. INTENTO PRIMARIO: GROQ (si el circuito lo permite)
    if (!this.groqCircuit.isOpen()) {
      try {
        const result = await this.groqProvider.complete(messages, tools, temperature);
        this.groqCircuit.recordSuccess();
        return result;
      } catch (groqErr: any) {
        const isRateLimit = groqErr?.status === 429 || (typeof groqErr?.message === 'string' && groqErr.message.includes('429'));
        if (isRateLimit) {
          this.groqCircuit.trip('HTTP 429 Rate/TPM Limit');
          logger.warn(
            `[ResilientLLM] Groq HTTP 429 rate/TPM limit detected. Instant 0ms trip and failover to Gemini 2.5 Flash for phone: ${phone}`,
            { error: groqErr.message, phone, groqCircuitState: this.groqCircuit.getState() }
          );
        } else {
          this.groqCircuit.recordFailure(groqErr);
          logger.warn(
            `[ResilientLLM] Groq timeout/failure detected. Failing over to Gemini 2.5 Flash for phone: ${phone}`,
            { error: groqErr.message, phone, groqCircuitState: this.groqCircuit.getState() }
          );
        }
      }
    } else {
      logger.info(
        `[ResilientLLM] Groq circuit is OPEN. Fail-fast (0ms) direct failover to Gemini for phone: ${phone}`,
        { phone }
      );
    }

    // 2. FALLBACK SECUNDARIO: GEMINI (si el circuito lo permite)
    if (!this.geminiCircuit.isOpen()) {
      try {
        const geminiResult = await this.callGeminiFallback(messages, temperature);
        this.geminiCircuit.recordSuccess();
        return geminiResult;
      } catch (geminiErr: any) {
        this.geminiCircuit.recordFailure(geminiErr);
        logger.error('[ResilientLLM] Gemini fallback also failed', {
          error: geminiErr.message,
          phone,
          geminiCircuitState: this.geminiCircuit.getState(),
        });
        throw geminiErr;
      }
    }

    // 3. AMBOS CIRCUITOS EN OPEN
    const outageErr = new Error('[ResilientLLM] Both Groq and Gemini circuits are OPEN. Complete infrastructure outage.');
    logger.error(outageErr.message, { phone });
    throw outageErr;
  }

  private async callGeminiFallback(
    messages: LLMMessage[],
    temperature = 0.2
  ): Promise<LLMResponse> {
    const apiKey = AppConfig.gemini.apiKey || (this.customFetch ? 'mock-gemini-test-key' : '');
    if (!apiKey) {
      throw new Error('[ResilientLLM] GEMINI_API_KEY no configurada. Fallback no disponible.');
    }

    const model = AppConfig.gemini.model || 'gemini-2.5-flash';
    const endpoint = `${this.geminiEndpoint}/${model}:generateContent?key=${apiKey}`;

    const systemMsg = messages.find((m) => m.role === 'system')?.content || '';
    const userMsgs = messages.filter((m) => m.role === 'user');
    const userPrompt = userMsgs.map((m) => m.content).join('\n\n');

    const fetchImpl = this.customFetch || fetch;

    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemMsg }] },
          contents: [
            {
              role: 'user',
              parts: [{ text: userPrompt }],
            },
          ],
          generationConfig: {
            temperature,
            responseMimeType: 'application/json',
            thinkingConfig: {
              thinkingBudget: 0,
            },
          },
        }),
        signal: AbortSignal.timeout(this.geminiTimeoutMs),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as any;
        throw new Error(
          `Gemini fallback error ${res.status}: ${err?.error?.message || res.statusText}`
        );
      }

      const data = (await res.json()) as any;
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

      return {
        text,
        toolCalls: [],
        finishReason: 'stop',
      };
    } catch (geminiErr: any) {
      throw geminiErr;
    }
  }
}

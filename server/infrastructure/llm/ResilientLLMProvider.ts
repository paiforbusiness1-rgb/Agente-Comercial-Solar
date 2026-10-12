/**
 * ResilientLLMProvider.ts — Microservicio de IA Resiliente con Fallback en Cascada
 * 
 * Arquitectura: Groq (primario, 7s timeout) → Gemini 2.5 Flash (fallback automático)
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
import { AppConfig } from '../../shared/config/AppConfig.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';

export class ResilientLLMProvider implements ILLMProvider {
  private groqProvider: ILLMProvider;
  private geminiEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models';

  constructor(
    groqProvider?: ILLMProvider,
    private customFetch?: typeof fetch,
    private geminiTimeoutMs: number = 7000
  ) {
    this.groqProvider = groqProvider || new GroqProvider();
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

    try {
      return await this.groqProvider.complete(messages, tools, temperature);
    } catch (groqErr: any) {
      // Refinamiento 2: Registro obligatorio de observabilidad con severidad warn
      logger.warn(
        `[ResilientLLM] Groq timeout/failure detected. Failing over to Gemini 2.5 Flash for phone: ${phone}`,
        { error: groqErr.message, phone }
      );

      return await this.callGeminiFallback(messages, temperature);
    }
  }

  private async callGeminiFallback(
    messages: LLMMessage[],
    temperature = 0.2
  ): Promise<LLMResponse> {
    const apiKey = AppConfig.gemini.apiKey;
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
      logger.error('[ResilientLLM] Both Groq and Gemini failed', {
        error: geminiErr.message,
      });
      throw geminiErr;
    }
  }
}

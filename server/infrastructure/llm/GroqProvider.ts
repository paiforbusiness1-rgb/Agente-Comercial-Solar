import {
  ILLMProvider, LLMMessage, LLMResponse, ToolDefinition,
} from '../../interfaces/ILLMProvider';
import { AppConfig } from '../../shared/config/AppConfig.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 800;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export class GroqProvider implements ILLMProvider {
  private readonly endpoint = 'https://api.groq.com/openai/v1/chat/completions';

  private get model(): string {
    return AppConfig.groq.model;
  }

  private get apiKey(): string {
    return AppConfig.groq.apiKey;
  }

  async complete(
    messages: LLMMessage[],
    tools?: ToolDefinition[],
    temperature = AppConfig.groq.temperature,
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({ type: 'function', function: t }));
      body.tool_choice = 'auto';
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        logger.debug(`[GroqProvider] Attempt ${attempt}/${MAX_RETRIES}`, {
          model: this.model,
          messagesCount: messages.length,
          hasTools: !!tools?.length,
        });

        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = await res.json() as any;
          const isRetryable = res.status === 429 || res.status >= 500;
          if (isRetryable && attempt < MAX_RETRIES) {
            logger.warn(`[GroqProvider] Retryable error ${res.status}, retrying in ${RETRY_DELAY_MS}ms...`);
            await sleep(RETRY_DELAY_MS * attempt);
            continue;
          }
          throw new Error(`Groq API error ${res.status}: ${err?.error?.message || res.statusText}`);
        }

        const data = await res.json() as any;
        const choice = data.choices?.[0];
        const message = choice?.message;
        const finishReason = choice?.finish_reason;

        if (finishReason === 'tool_calls' && message?.tool_calls) {
          return {
            text: null,
            finishReason: 'tool_calls',
            toolCalls: message.tool_calls.map((tc: any) => ({
              id: tc.id,
              name: tc.function.name,
              arguments: JSON.parse(tc.function.arguments || '{}'),
            })),
          };
        }

        return {
          text: message?.content || '',
          finishReason: 'stop',
          toolCalls: [],
        };
      } catch (err: any) {
        if (attempt === MAX_RETRIES) {
          logger.error('[GroqProvider] All retries exhausted', { error: err.message });
          throw err;
        }
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }

    throw new Error('[GroqProvider] Unexpected exit from retry loop');
  }
}

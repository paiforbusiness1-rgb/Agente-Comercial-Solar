/**
 * SofiaPromptBuilder.ts
 * Implements MCP (Model Context Protocol) and SSD (Security by Design).
 * Constructs LLM prompts using XML tags to encapsulate user input safely
 * and requests strict JSON output schemas.
 */

export interface UserContext {
  phone: string;
  userName?: string;
  currentStep: number;
  extractedData: {
    billAmount?: number;
    roofType?: string;
    meterDistance?: string;
    extraLoads?: string;
    location?: string;
    ownership?: string;
  };
  botDisabled: boolean;
  latestUserMessage: string;
  historySummary?: string;
}

export interface SofiaLlmResponse {
  next_step: number;
  message_to_user: string;
  extracted_data?: {
    bill_amount?: number;
    roof_type?: string;
    meter_distance?: string;
    extra_loads?: string;
    location?: string;
    ownership?: string;
  };
  trigger_human_handoff: boolean;
  handoff_reason?: string;
  media_to_send?: 'FINANCIAMIENTO' | 'INSTALACION_PROFESIONAL' | 'COTIZACION_PDF' | null;
}

export class SofiaPromptBuilder {
  /**
   * Sanitizes user input string to prevent XML tag injection attacks (SSD).
   */
  private static sanitizeInput(input: string): string {
    if (!input) return '';
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Builds system prompt and XML-delimited user context for Sofía IA.
   */
  public static buildPrompt(ctx: UserContext): { systemPrompt: string; userContent: string } {
    const systemPrompt = `Eres Sofía, Asesora Comercial de O3 Energy México.
Tu personalidad es cálida, profesional, empática y de alta conversión comercial.
Tu objetivo es guiar al cliente en un flujo comercial de 6 pasos de forma fluida y natural en WhatsApp.

REGLAS DE INTERACCIÓN (U-First & MCP):
1. Sé súper humana, amable y clara. Usa emojis con sutileza.
2. NUNCA fuerces al cliente si no sabe un dato técnico (ej: tipo de techo, distancia al medidor). Si dice "no sé", "no estoy seguro", etc., responde empáticamente ("¡No te preocupes! Nuestros ingenieros lo medirán en la visita técnica gratuita") y avanza al siguiente paso.
3. Ofrece la opción de hablar con un agente humano cuando el usuario tenga dudas complejas o lo solicite explícitamente.
4. Tu respuesta DEBE SER UN OBJETO JSON VÁLIDO exactamente con la estructura definida a continuación.

ESTRUCTURA JSON OBLIGATORIA DE RESPUESTA:
{
  "next_step": number, // Paso actual o siguiente (1 a 6)
  "message_to_user": "Texto del mensaje para enviar por WhatsApp",
  "extracted_data": {
    "bill_amount": number | null,
    "roof_type": string | null,
    "meter_distance": string | null,
    "extra_loads": string | null,
    "location": string | null,
    "ownership": string | null
  },
  "trigger_human_handoff": boolean, // true si el usuario pide hablar con un agente o asesor humano
  "handoff_reason": string | null,
  "media_to_send": "FINANCIAMIENTO" | "INSTALACION_PROFESIONAL" | "COTIZACION_PDF" | null
}`;

    const cleanMessage = this.sanitizeInput(ctx.latestUserMessage);
    const cleanName = this.sanitizeInput(ctx.userName || 'Cliente');
    const cleanHistory = this.sanitizeInput(ctx.historySummary || '');

    const userContent = `<context>
  <user_profile>
    <phone>${ctx.phone}</phone>
    <name>${cleanName}</name>
  </user_profile>
  <current_state>
    <step>${ctx.currentStep}</step>
    <bot_disabled>${ctx.botDisabled}</bot_disabled>
    <data_collected>${JSON.stringify(ctx.extractedData)}</data_collected>
  </current_state>
  <history_summary>${cleanHistory}</history_summary>
  <user_message>${cleanMessage}</user_message>
</context>`;

    return { systemPrompt, userContent };
  }

  /**
   * Validates and parses the LLM output string to ensure it matches SofiaLlmResponse schema (SQA).
   */
  public static parseResponse(rawResponse: string): SofiaLlmResponse {
    try {
      // Clean markdown code blocks if wrapped in ```json ... ```
      let jsonStr = rawResponse.trim();
      if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      const parsed = JSON.parse(jsonStr) as SofiaLlmResponse;
      return {
        next_step: typeof parsed.next_step === 'number' ? parsed.next_step : 1,
        message_to_user: parsed.message_to_user || 'Hola, ¿en qué puedo ayudarte hoy?',
        extracted_data: parsed.extracted_data || {},
        trigger_human_handoff: Boolean(parsed.trigger_human_handoff),
        handoff_reason: parsed.handoff_reason || undefined,
        media_to_send: parsed.media_to_send || null,
      };
    } catch (err) {
      // Fallback response on parse failure (SQA)
      return {
        next_step: 1,
        message_to_user: rawResponse,
        trigger_human_handoff: false,
        media_to_send: null,
      };
    }
  }
}

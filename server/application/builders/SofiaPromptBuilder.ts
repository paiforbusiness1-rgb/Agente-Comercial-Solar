/**
 * SofiaPromptBuilder.ts
 * Implements MCP (Model Context Protocol) and SSD (Security by Design).
 * Constructs LLM prompts using XML tags to encapsulate user input safely,
 * handles graceful name extraction, quotation consent gating, and JSON schemas.
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
  quoteConsentRequested?: boolean;
  quoteConsentGiven?: boolean;
  botDisabled: boolean;
  latestUserMessage: string;
  historySummary?: string;
}

export interface SofiaLlmResponse {
  next_step: number;
  message_to_user: string;
  extracted_data?: {
    client_name?: string | null;
    bill_amount?: number | null;
    roof_type?: string | null;
    meter_distance?: string | null;
    extra_loads?: string | null;
    location?: string | null;
    ownership?: string | null;
  };
  quote_consent_requested?: boolean;
  quote_consent_given?: boolean;
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
Tu personalidad es cálida, empática, profesional y altamente orientada a brindar una excelente experiencia de usuario (U-First).
Tu objetivo es guiar al cliente en un flujo comercial consultivo de 6 pasos en WhatsApp.

REGLAS ESENCIALES DE INTERACCIÓN:

1. MANEJO GRACEFUL DEL NOMBRE (PASO 1):
   - Si el cliente menciona su nombre en el mensaje inicial (ej. "Hola soy Carlos y pago $2,800 de luz"), extráelo en "client_name": "Carlos" y salúdalo por su nombre de inmediato.
   - Si el cliente NO da su nombre (es decir, el nombre actual es "Cliente"), salúdalo cálidamente y solicítale su nombre de forma amable, pero NUNCA ignores los otros datos que ya te haya dado (ej. si dio su recibo o ubicación, guárdalos).

2. GATING DE CONSENTIMIENTO PARA COTIZACIÓN (PASO 4):
   - Al contar con el recibo y tipo de techo, NUNCA muestres la cotización masiva directamente de golpe.
   - En su lugar, haz una pregunta de abreboca ofreciendo la cotización:
     "¡Excelente [Nombre]! Con un consumo de $[Monto], tu sistema ideal es de aproximadamente [N] paneles solares. ¿Te gustaría que te presente la propuesta preliminar de inversión y ahorro estimado?"
   - Si el cliente responde afirmativamente ("Sí", "Adelante", "Por favor", "Muéstramela"), establece "quote_consent_given": true.

3. PROACTIVIDAD EN FINANCIAMIENTO Y RESPALDO TÉCNICO:
   - Tras presentar la propuesta o en Paso 2/3, menciona que O3 Energy México cuenta con ingenieros certificados, 15+ años de experiencia, app de monitoreo y garantías Tier 1. Solicita "media_to_send": "INSTALACION_PROFESIONAL".
   - Al hablar de costos, presenta proactivamente las opciones de pago (contado vs. financiamiento con enganche desde 10%) y solicita "media_to_send": "FINANCIAMIENTO".

4. RESPUESTAS LIMPIAS Y NO REPETITIVAS:
   - Responde de forma directa a las preguntas específicas del usuario (ej: sobre instaladores, garantías, financiamiento) sin volver a repetir la tarjeta larga de cotización en cada turno.

ESTRUCTURA JSON OBLIGATORIA DE RESPUESTA:
{
  "next_step": number, // Paso actual (1 a 6)
  "message_to_user": "Texto del mensaje para WhatsApp",
  "extracted_data": {
    "client_name": string | null,
    "bill_amount": number | null,
    "roof_type": string | null,
    "meter_distance": string | null,
    "extra_loads": string | null,
    "location": string | null,
    "ownership": string | null
  },
  "quote_consent_requested": boolean,
  "quote_consent_given": boolean,
  "trigger_human_handoff": boolean,
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
    <quote_consent_requested>${Boolean(ctx.quoteConsentRequested)}</quote_consent_requested>
    <quote_consent_given>${Boolean(ctx.quoteConsentGiven)}</quote_consent_given>
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
        quote_consent_requested: Boolean(parsed.quote_consent_requested),
        quote_consent_given: Boolean(parsed.quote_consent_given),
        trigger_human_handoff: Boolean(parsed.trigger_human_handoff),
        handoff_reason: parsed.handoff_reason || undefined,
        media_to_send: parsed.media_to_send || null,
      };
    } catch (err) {
      return {
        next_step: 1,
        message_to_user: rawResponse,
        trigger_human_handoff: false,
        media_to_send: null,
      };
    }
  }
}

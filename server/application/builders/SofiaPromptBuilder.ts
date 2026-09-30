/**
 * SofiaPromptBuilder.ts
 * Implements MCP (Model Context Protocol) and SSD (Security by Design).
 * Constructs LLM prompts using XML tags to encapsulate user input safely,
 * handles graceful name extraction, quotation consent gating, JSON schemas,
 * zero-hallucination Single Source of Truth calculation injection,
 * and proactive free technical visit / specialized human advisor handoff rules.
 */

export interface UserContext {
  phone: string;
  userName?: string;
  currentStep: number;
  extractedData: {
    billAmount?: number;
    billFrequency?: 'bimestral' | 'mensual';
    roofType?: string;
    meterDistance?: string;
    extraLoads?: string;
    location?: string;
    ownership?: string;
  };
  calculatedQuote?: {
    panels: number;
    systemPowerKw: number;
    estimatedCost: number;
    monthlySavings: number;
    annualSavings: number;
    rangeLabel: string;
  } | null;
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
    bill_frequency?: 'bimestral' | 'mensual' | null;
    roof_type?: string | null;
    meter_distance?: string | null;
    extra_loads?: string | null;
    location?: string | null;
    ownership?: string | null;
  };
  quote_consent_requested?: boolean;
  quote_consent_given?: boolean;
  propose_technical_visit?: boolean;
  propose_advisor_handoff?: boolean;
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
    const calculatedQuoteStr = ctx.calculatedQuote
      ? JSON.stringify(ctx.calculatedQuote)
      : 'No disponible aún (requiere monto de recibo)';

    const systemPrompt = `Eres Sofía, Asesora Comercial de O3 Energy México.
Tu personalidad es cálida, empática, profesional y altamente orientada a brindar una excelente experiencia de usuario (U-First).
Tu objetivo es guiar al cliente en un flujo comercial consultivo de 6 pasos en WhatsApp.

REGLAS ESENCIALES DE INTERACCIÓN Y CERO ALUCINACIÓN:

1. MANEJO GRACEFUL DEL NOMBRE (PASO 1):
   - Si el cliente menciona su nombre en el mensaje inicial (ej. "Hola soy Carlos y pago $2,800 de luz"), extráelo en "client_name": "Carlos" y salúdalo por su nombre de inmediato.
   - Si el cliente NO da su nombre (es decir, el nombre actual es "Cliente"), salúdalo cálidamente y solicítale su nombre de forma amable, pero NUNCA ignores los otros datos que ya te haya dado.

2. CERO ALUCINACIÓN DE PANELES Y NÚMEROS (FUENTE ÚNICA DE LA VERDAD):
   - NUNCA inventes o menciones una cantidad de paneles solares o montos si NO dispones de los valores calculados en <calculated_quote>.
   - Si <calculated_quote> contiene datos, utiliza EXCLUSIVAMENTE esa cifra de paneles (ej. si indica 4 paneles, menciona 4 paneles; si indica 6 paneles, menciona 6 paneles).
   - Si el usuario pregunta cuántos paneles necesita ANTES de indicar su recibo, responde con elegancia: "Para darte el número exacto de paneles y el costo de tu inversión, necesito conocer tu consumo mensual o bimestral en pesos de tu recibo CFE. ¿Cuánto pagas aproximadamente?" NUNCA inventes un número de paneles.

3. CONVERSIÓN Y DESGLOSE TRANSPARENTE DE RECI BOS CFE (BIMESTRAL VS. MENSUAL):
   - En México los recibos CFE son habitualmente BIMESTRALES.
   - Si el usuario menciona un monto (ej. $2,800) y no aclara frecuencia, o si dice "bimestral", extrae "bill_frequency": "bimestral".
   - Al responder, desglosa SIEMPRE de forma clara y transparente la equivalencia: "Tu recibo bimestral de $2,800 MXN equivale a $1,400 MXN al mes. Con este consumo, tu sistema ideal es de [N de <calculated_quote>] paneles solares...".

4. GATING DE CONSENTIMIENTO PARA COTIZACIÓN (PASO 4):
   - Al contar con el recibo y tipo de techo, no muestres la cotización masiva directamente de golpe.
   - Haz una pregunta de abreboca ofreciendo la cotización:
     "¡Excelente [Nombre]! Con un consumo de $[Monto], tu sistema ideal es de aproximadamente [N] paneles solares de alta eficiencia. ¿Te gustaría que te presente la propuesta preliminar de inversión y ahorro estimado?"
   - Si el cliente responde afirmativamente ("Sí", "Adelante", "Por favor", "Muéstramela"), establece "quote_consent_given": true.

5. PROPUESTA PROACTIVA DE VISITA TÉCNICA GRATUITA EN SITIO:
   - Si el usuario no tiene la foto del recibo a la mano ("No la tengo a la mano") o al avanzar en la calificación del techo/sombras (Pasos 3 y 4), ofrece proactivamente una Visita Técnica Gratuita en Sitio por nuestros ingenieros certificados para evaluar la estructura, sombras y trayectoria eléctrica. Establece "propose_technical_visit": true. El bot PERMANECE ACTIVO (botDisabled = false).

6. CANALIZACIÓN CON ASESOR COMERCIAL ESPECIALIZADO:
   - Si el usuario solicita hablar con una persona, requiere asesoría personalizada avanzada o pide la llamada de un especialista, establece "trigger_human_handoff": true, "propose_advisor_handoff": true y "handoff_reason": "Solicitud de atención humana".

7. RESPUESTAS LIMPIAS Y NO REPETITIVAS:
   - Responde de forma directa a las preguntas específicas del usuario sin volver a repetir la tarjeta larga de cotización en cada turno.

8. ANUNCIO CÁLIDO DEL BROCHURE / INFOGRAFÍA (U-FIRST UX):
   - Cuando vayas a solicitar el envío del brochure o infografía ("media_to_send": "INSTALACION_PROFESIONAL"), incluye SIEMPRE al final de tu mensaje de texto una frase amable anunciándolo:
     "¡Mientras tanto, te comparto un brochure para que conozcas nuestros servicios e instalación profesional! 📄☀️"

ESTRUCTURA JSON OBLIGATORIA DE RESPUESTA:
{
  "next_step": number, // Paso actual (1 a 6)
  "message_to_user": "Texto del mensaje para WhatsApp",
  "extracted_data": {
    "client_name": string | null,
    "bill_amount": number | null,
    "bill_frequency": "bimestral" | "mensual" | null,
    "roof_type": string | null,
    "meter_distance": string | null,
    "extra_loads": string | null,
    "location": string | null,
    "ownership": string | null
  },
  "quote_consent_requested": boolean,
  "quote_consent_given": boolean,
  "propose_technical_visit": boolean,
  "propose_advisor_handoff": boolean,
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
  <calculated_quote>${calculatedQuoteStr}</calculated_quote>
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
        propose_technical_visit: Boolean(parsed.propose_technical_visit),
        propose_advisor_handoff: Boolean(parsed.propose_advisor_handoff),
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

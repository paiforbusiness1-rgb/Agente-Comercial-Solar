// api_src/index.ts
import express from "express";
import { initializeApp, getApps as getApps3, cert } from "firebase-admin/app";
import { getFirestore as getFirestore2 } from "firebase-admin/firestore";
import nodemailer2 from "nodemailer";

// server/infrastructure/web/v2Router.ts
import { Router } from "express";

// server/shared/config/AppConfig.ts
var AppConfig = {
  get env() {
    return process.env.NODE_ENV || "development";
  },
  get port() {
    return parseInt(process.env.PORT || "3000", 10);
  },
  get tenant() {
    return {
      defaultId: process.env.TENANT_DEFAULT_ID || "o3energy_mexico"
    };
  },
  get meta() {
    return {
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "O3_ENERGY_MEXICO_TOKEN",
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || ""
    };
  },
  get groq() {
    return {
      apiKey: process.env.GROQ_API_KEY || "",
      model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
      temperature: parseFloat(process.env.GROQ_TEMPERATURE || "0.7")
    };
  },
  get smtp() {
    return {
      server: process.env.SMTP_SERVER || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587", 10),
      user: process.env.SENDER_EMAIL || "alertas@o3energy.mx",
      pass: process.env.SENDER_PASSWORD || "",
      salesEmail: process.env.SALES_EMAIL || "ventas@o3energy.mx"
    };
  },
  get mediaBaseUrl() {
    return process.env.MEDIA_BASE_URL || "https://agente-comercial-solar.vercel.app/images";
  },
  get appUrl() {
    return process.env.APP_URL || "https://agente-comercial-solar.vercel.app";
  }
};

// server/shared/logger/ConsoleLogger.ts
var ConsoleLogger = class {
  formatMeta(meta) {
    return meta ? ` | ${JSON.stringify(meta)}` : "";
  }
  info(message, meta) {
    console.log(`[INFO]  ${(/* @__PURE__ */ new Date()).toISOString()} \u2014 ${message}${this.formatMeta(meta)}`);
  }
  warn(message, meta) {
    console.warn(`[WARN]  ${(/* @__PURE__ */ new Date()).toISOString()} \u2014 ${message}${this.formatMeta(meta)}`);
  }
  error(message, meta) {
    console.error(`[ERROR] ${(/* @__PURE__ */ new Date()).toISOString()} \u2014 ${message}${this.formatMeta(meta)}`);
  }
  debug(message, meta) {
    if (process.env.NODE_ENV !== "production") {
      console.debug(`[DEBUG] ${(/* @__PURE__ */ new Date()).toISOString()} \u2014 ${message}${this.formatMeta(meta)}`);
    }
  }
};
var logger = new ConsoleLogger();

// server/infrastructure/llm/GroqProvider.ts
var MAX_RETRIES = 3;
var RETRY_DELAY_MS = 800;
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
var GroqProvider = class {
  constructor() {
    this.endpoint = "https://api.groq.com/openai/v1/chat/completions";
  }
  get model() {
    return AppConfig.groq.model;
  }
  get apiKey() {
    return AppConfig.groq.apiKey;
  }
  async complete(messages, tools, temperature = AppConfig.groq.temperature) {
    const body = {
      model: this.model,
      messages,
      temperature
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({ type: "function", function: t }));
      body.tool_choice = "auto";
    }
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        logger.debug(`[GroqProvider] Attempt ${attempt}/${MAX_RETRIES}`, {
          model: this.model,
          messagesCount: messages.length,
          hasTools: !!tools?.length
        });
        const res = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const err = await res.json();
          const isRetryable = res.status === 429 || res.status >= 500;
          if (isRetryable && attempt < MAX_RETRIES) {
            logger.warn(`[GroqProvider] Retryable error ${res.status}, retrying in ${RETRY_DELAY_MS}ms...`);
            await sleep(RETRY_DELAY_MS * attempt);
            continue;
          }
          throw new Error(`Groq API error ${res.status}: ${err?.error?.message || res.statusText}`);
        }
        const data = await res.json();
        const choice = data.choices?.[0];
        const message = choice?.message;
        const finishReason = choice?.finish_reason;
        if (finishReason === "tool_calls" && message?.tool_calls) {
          return {
            text: null,
            finishReason: "tool_calls",
            toolCalls: message.tool_calls.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              arguments: JSON.parse(tc.function.arguments || "{}")
            }))
          };
        }
        return {
          text: message?.content || "",
          finishReason: "stop",
          toolCalls: []
        };
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          logger.error("[GroqProvider] All retries exhausted", { error: err.message });
          throw err;
        }
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
    throw new Error("[GroqProvider] Unexpected exit from retry loop");
  }
};

// server/shared/config/pricingMatrix.json
var pricingMatrix_default = {
  currency: "MXN",
  taxIncluded: true,
  defaultRoiYears: 3,
  roundingRule: "NEXT_EVEN",
  disclaimer: "Nota: Este presupuesto es una estimaci\xF3n preliminar basada en tu consumo reportado. El costo y dimensionamiento final ser\xE1n confirmados por nuestros Ingenieros T\xE9cnicos durante la visita gratuita a tu domicilio (evaluaci\xF3n de inclinaci\xF3n de techo, sombras y trayectoria el\xE9ctrica).",
  panelPowerW: 550,
  tiers: [
    {
      minBimestralBill: 0,
      maxBimestralBill: 4e3,
      minMonthlyBill: 0,
      maxMonthlyBill: 2e3,
      panels: 4,
      systemKwp: 2.2,
      priceMxn: 26e3,
      roiYears: 2.5,
      rangeLabel: "4 paneles solares (2.2 kWp)"
    },
    {
      minBimestralBill: 4e3,
      maxBimestralBill: 6e3,
      minMonthlyBill: 2e3,
      maxMonthlyBill: 3e3,
      panels: 6,
      systemKwp: 3.3,
      priceMxn: 38900,
      roiYears: 2.8,
      rangeLabel: "6 paneles solares (3.3 kWp)"
    },
    {
      minBimestralBill: 6e3,
      maxBimestralBill: 8e3,
      minMonthlyBill: 3e3,
      maxMonthlyBill: 4e3,
      panels: 8,
      systemKwp: 4.4,
      priceMxn: 51900,
      roiYears: 3,
      rangeLabel: "8 paneles solares (4.4 kWp)"
    },
    {
      minBimestralBill: 8e3,
      maxBimestralBill: 1e4,
      minMonthlyBill: 4e3,
      maxMonthlyBill: 5e3,
      panels: 10,
      systemKwp: 5.5,
      priceMxn: 64800,
      roiYears: 3.2,
      rangeLabel: "10 paneles solares (5.5 kWp)"
    },
    {
      minBimestralBill: 1e4,
      maxBimestralBill: 999999,
      minMonthlyBill: 5e3,
      maxMonthlyBill: 999999,
      panels: 12,
      systemKwp: 6.6,
      priceMxn: 77700,
      roiYears: 3.5,
      rangeLabel: "12+ paneles solares (Sistema Traje a Medida)"
    }
  ]
};

// server/infrastructure/engines/SolarQuoteEngine.ts
var matrix = pricingMatrix_default;
var EXTRA_LOAD_FACTOR = 1.25;
var SolarQuoteEngine = class {
  calculate(monthlyBillMxn, extraLoad = false) {
    const effectiveMonthlyBill = extraLoad ? monthlyBillMxn * EXTRA_LOAD_FACTOR : monthlyBillMxn;
    const bimestralBillEquivalent = effectiveMonthlyBill * 2;
    const tier = matrix.tiers.find(
      (t) => bimestralBillEquivalent >= t.minBimestralBill && bimestralBillEquivalent < t.maxBimestralBill
    ) ?? matrix.tiers[matrix.tiers.length - 1];
    let panels = tier.panels;
    if (matrix.roundingRule === "NEXT_EVEN" && panels % 2 !== 0) {
      panels += 1;
    }
    const systemPowerKw = tier.systemKwp;
    const estimatedCost = tier.priceMxn;
    const roiYears = tier.roiYears || matrix.defaultRoiYears;
    const annualSavings = Math.round(monthlyBillMxn * 0.9 * 12);
    const monthlySavings = Math.round(annualSavings / 12);
    return {
      monthlyBill: monthlyBillMxn,
      panels,
      systemPowerKw,
      estimatedCost,
      roiYears,
      monthlySavings,
      annualSavings,
      monthlySavingsFormatted: `$${monthlySavings.toLocaleString("es-MX")} MXN`,
      annualSavingsFormatted: `$${annualSavings.toLocaleString("es-MX")} MXN`,
      costFormatted: `$${estimatedCost.toLocaleString("es-MX")} MXN (IVA incluido)`,
      systemDescription: `${panels} paneles solares de alta eficiencia (${systemPowerKw.toFixed(1)} kWp)`,
      disclaimer: matrix.disclaimer
    };
  }
};

// server/infrastructure/persistence/Repositories.ts
var chatsStore = {};
var leadsStore = {};
var defaultState = () => ({
  phase: "GREETING",
  completedSteps: [],
  missingFields: ["name", "isOwner", "monthlyBill"],
  leadScore: 0
});
var InMemoryConversationRepository = class {
  async findByPhone(tenantId, phone) {
    const key = `${tenantId}::${phone}`;
    if (!chatsStore[key]) {
      chatsStore[key] = {
        id: phone,
        tenantId,
        phone,
        nombre: "Cliente",
        botDisabled: false,
        messages: [],
        state: defaultState(),
        lastMessageAt: (/* @__PURE__ */ new Date()).toISOString(),
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    return chatsStore[key];
  }
  async save(conversation) {
    const key = `${conversation.tenantId}::${conversation.phone}`;
    chatsStore[key] = conversation;
  }
  async findAll(tenantId) {
    return Object.values(chatsStore).filter((c) => c.tenantId === tenantId);
  }
};
var InMemoryLeadRepository = class {
  async save(lead) {
    leadsStore[lead.id] = lead;
  }
  async findAll(tenantId) {
    return Object.values(leadsStore).filter((l) => l.tenantId === tenantId);
  }
  async updateStatus(tenantId, leadId, status) {
    if (leadsStore[leadId]) leadsStore[leadId].status = status;
  }
  async updateNotes(tenantId, leadId, notes) {
    if (leadsStore[leadId]) leadsStore[leadId].privateNotes = notes;
  }
};
var inMemoryConvFallback = new InMemoryConversationRepository();
var inMemoryLeadFallback = new InMemoryLeadRepository();
var FirestoreConversationRepository = class {
  constructor(db2) {
    this.db = db2;
  }
  async findByPhone(tenantId, phone) {
    try {
      const docRef = this.db.collection(`tenants/${tenantId}/chats`).doc(phone);
      const doc = await docRef.get();
      if (!doc.exists) {
        const conv = {
          id: phone,
          tenantId,
          phone,
          nombre: "Cliente",
          botDisabled: false,
          messages: [],
          state: defaultState(),
          lastMessageAt: (/* @__PURE__ */ new Date()).toISOString(),
          createdAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        await docRef.set(conv);
        return conv;
      }
      return { id: doc.id, ...doc.data() };
    } catch (err) {
      logger.warn("[FirestoreConversationRepo] Fallback to In-Memory due to Firestore error", { error: err.message });
      return inMemoryConvFallback.findByPhone(tenantId, phone);
    }
  }
  async save(conversation) {
    await inMemoryConvFallback.save(conversation);
    try {
      await this.db.collection(`tenants/${conversation.tenantId}/chats`).doc(conversation.phone).set(conversation, { merge: true });
    } catch (err) {
      logger.warn("[FirestoreConversationRepo] Firestore save failed (using in-memory fallback)", { error: err.message });
    }
  }
  async findAll(tenantId) {
    try {
      const snap = await this.db.collection(`tenants/${tenantId}/chats`).orderBy("lastMessageAt", "desc").get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (err) {
      logger.warn("[FirestoreConversationRepo] Fallback to In-Memory for findAll", { error: err.message });
      return inMemoryConvFallback.findAll(tenantId);
    }
  }
};
var FirestoreLeadRepository = class {
  constructor(db2) {
    this.db = db2;
  }
  async save(lead) {
    await inMemoryLeadFallback.save(lead);
    try {
      await this.db.collection(`tenants/${lead.tenantId}/qualified_leads`).doc(lead.id).set(lead, { merge: true });
      logger.info("[FirestoreLeadRepo] Lead saved", { leadId: lead.id, tenantId: lead.tenantId });
    } catch (err) {
      logger.warn("[FirestoreLeadRepo] Firestore save failed (using in-memory fallback)", { error: err.message });
    }
  }
  async findAll(tenantId) {
    try {
      const snap = await this.db.collection(`tenants/${tenantId}/qualified_leads`).orderBy("createdAt", "desc").get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (err) {
      logger.warn("[FirestoreLeadRepo] Fallback to In-Memory for findAll", { error: err.message });
      return inMemoryLeadFallback.findAll(tenantId);
    }
  }
  async updateStatus(tenantId, leadId, status) {
    await inMemoryLeadFallback.updateStatus(tenantId, leadId, status);
    try {
      await this.db.collection(`tenants/${tenantId}/qualified_leads`).doc(leadId).update({ status });
    } catch (err) {
      logger.warn("[FirestoreLeadRepo] Firestore updateStatus failed", { error: err.message });
    }
  }
  async updateNotes(tenantId, leadId, notes) {
    await inMemoryLeadFallback.updateNotes(tenantId, leadId, notes);
    try {
      await this.db.collection(`tenants/${tenantId}/qualified_leads`).doc(leadId).set({ privateNotes: notes }, { merge: true });
    } catch (err) {
      logger.warn("[FirestoreLeadRepo] Firestore updateNotes failed", { error: err.message });
    }
  }
};

// server/application/usecases/ReceiveMessageUseCase.ts
var ReceiveMessageUseCase = class {
  constructor(convRepo, orchestrator, sendWhatsApp, sendWhatsAppMedia2) {
    this.convRepo = convRepo;
    this.orchestrator = orchestrator;
    this.sendWhatsApp = sendWhatsApp;
    this.sendWhatsAppMedia = sendWhatsAppMedia2;
  }
  async execute(input) {
    const tenantId = input.tenantId || AppConfig.tenant.defaultId;
    const phone = input.phone.replace(/[^\d]/g, "");
    logger.info("[ReceiveMessageUseCase] Message received", {
      phone,
      tenantId,
      text: input.text.substring(0, 60)
    });
    const result = await this.orchestrator.processMessage({
      tenantId,
      phone,
      userName: input.name,
      messageText: input.text
    });
    if (result.replyText) {
      await this.sendWhatsApp(phone, result.replyText);
    }
    if (result.mediaSent && result.mediaSent.length > 0) {
      for (const mediaUrl of result.mediaSent) {
        await this.sendWhatsAppMedia(phone, mediaUrl);
      }
    }
    logger.info("[ReceiveMessageUseCase] Execution finished", {
      phone,
      nextStep: result.nextStep,
      botDisabled: result.botDisabled
    });
    return { reply: result.replyText, leadGenerated: result.botDisabled };
  }
};

// server/application/builders/SofiaPromptBuilder.ts
var SofiaPromptBuilder = class {
  /**
   * Sanitizes user input string to prevent XML tag injection attacks (SSD).
   */
  static sanitizeInput(input) {
    if (!input) return "";
    return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  /**
   * Builds system prompt and XML-delimited user context for Sofía IA.
   */
  static buildPrompt(ctx) {
    const systemPrompt = `Eres Sof\xEDa, Asesora Comercial de O3 Energy M\xE9xico.
Tu personalidad es c\xE1lida, emp\xE1tica, profesional y altamente orientada a brindar una excelente experiencia de usuario (U-First).
Tu objetivo es guiar al cliente en un flujo comercial consultivo de 6 pasos en WhatsApp.

REGLAS ESENCIALES DE INTERACCI\xD3N:

1. MANEJO GRACEFUL DEL NOMBRE (PASO 1):
   - Si el cliente menciona su nombre en el mensaje inicial (ej. "Hola soy Carlos y pago $2,800 de luz"), extr\xE1elo en "client_name": "Carlos" y sal\xFAdalo por su nombre de inmediato.
   - Si el cliente NO da su nombre (es decir, el nombre actual es "Cliente"), sal\xFAdalo c\xE1lidamente y solic\xEDtale su nombre de forma amable, pero NUNCA ignores los otros datos que ya te haya dado (ej. si dio su recibo o ubicaci\xF3n, gu\xE1rdalos).

2. GATING DE CONSENTIMIENTO PARA COTIZACI\xD3N (PASO 4):
   - Al contar con el recibo y tipo de techo, NUNCA muestres la cotizaci\xF3n masiva directamente de golpe.
   - En su lugar, haz una pregunta de abreboca ofreciendo la cotizaci\xF3n:
     "\xA1Excelente [Nombre]! Con un consumo de $[Monto], tu sistema ideal es de aproximadamente [N] paneles solares. \xBFTe gustar\xEDa que te presente la propuesta preliminar de inversi\xF3n y ahorro estimado?"
   - Si el cliente responde afirmativamente ("S\xED", "Adelante", "Por favor", "Mu\xE9stramela"), establece "quote_consent_given": true.

3. PROACTIVIDAD EN FINANCIAMIENTO Y RESPALDO T\xC9CNICO:
   - Tras presentar la propuesta o en Paso 2/3, menciona que O3 Energy M\xE9xico cuenta con ingenieros certificados, 15+ a\xF1os de experiencia, app de monitoreo y garant\xEDas Tier 1. Solicita "media_to_send": "INSTALACION_PROFESIONAL".
   - Al hablar de costos, presenta proactivamente las opciones de pago (contado vs. financiamiento con enganche desde 10%) y solicita "media_to_send": "FINANCIAMIENTO".

4. RESPUESTAS LIMPIAS Y NO REPETITIVAS:
   - Responde de forma directa a las preguntas espec\xEDficas del usuario (ej: sobre instaladores, garant\xEDas, financiamiento) sin volver a repetir la tarjeta larga de cotizaci\xF3n en cada turno.

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
    const cleanName = this.sanitizeInput(ctx.userName || "Cliente");
    const cleanHistory = this.sanitizeInput(ctx.historySummary || "");
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
  static parseResponse(rawResponse) {
    try {
      let jsonStr = rawResponse.trim();
      if (jsonStr.startsWith("```json")) {
        jsonStr = jsonStr.replace(/^```json\s*/, "").replace(/\s*```$/, "");
      } else if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/^```\s*/, "").replace(/\s*```$/, "");
      }
      const parsed = JSON.parse(jsonStr);
      return {
        next_step: typeof parsed.next_step === "number" ? parsed.next_step : 1,
        message_to_user: parsed.message_to_user || "Hola, \xBFen qu\xE9 puedo ayudarte hoy?",
        extracted_data: parsed.extracted_data || {},
        quote_consent_requested: Boolean(parsed.quote_consent_requested),
        quote_consent_given: Boolean(parsed.quote_consent_given),
        trigger_human_handoff: Boolean(parsed.trigger_human_handoff),
        handoff_reason: parsed.handoff_reason || void 0,
        media_to_send: parsed.media_to_send || null
      };
    } catch (err) {
      return {
        next_step: 1,
        message_to_user: rawResponse,
        trigger_human_handoff: false,
        media_to_send: null
      };
    }
  }
};

// server/infrastructure/services/QuotePdfService.ts
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs";
import path from "path";
import { getApps } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
var QuotePdfService = class {
  /**
   * Generates an authentic binary PDF file on-the-fly matching O3 Energy corporate layout.
   */
  static async generateQuote(dto) {
    const formattedCost = `$${dto.totalCostMxn.toLocaleString("es-MX")} MXN (IVA incluido)`;
    const formattedMonthlySavings = `$${dto.monthlySavingsMxn.toLocaleString("es-MX")} MXN/mes`;
    const formattedAnnualSavings = `$${dto.annualSavingsMxn.toLocaleString("es-MX")} MXN/a\xF1o`;
    const textSummary = `\u{1F4CB} *PRESUPUESTO PRELIMINAR DE SISTEMA SOLAR* \u2600\uFE0F
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u{1F464} *Cliente:* ${dto.clientName}
\u{1F4F1} *Contacto:* ${dto.clientPhone}
\u{1F4CD} *Ubicaci\xF3n:* ${dto.location || "Chihuahua, Chih."}

\u26A1 *DIAGN\xD3STICO ENERG\xC9TICO:*
\u2022 Consumo reportado: $${dto.monthlyBillMxn.toLocaleString("es-MX")} MXN/mes
\u2022 Sistema sugerido: *${dto.panelsCount} Paneles Solares* de Alta Eficiencia (${dto.systemPowerKwp.toFixed(1)} kWp)

\u{1F4B0} *INVERSI\xD3N Y AHORRO ESTIMADO:*
\u2022 Inversi\xF3n Total: *${formattedCost}*
\u2022 Ahorro estimado mensual: *${formattedMonthlySavings}* (~90% de reducci\xF3n)
\u2022 Ahorro estimado anual: *${formattedAnnualSavings}*
\u2022 Retorno de Inversi\xF3n (ROI): *~2.5 a 3 a\xF1os*

\u{1F381} *INCLUYE:*
\u2705 Paneles solares nivel Tier 1 con 25 a\xF1os de garant\xEDa
\u2705 Microinversores inteligentes
\u2705 Tr\xE1mite de interconexi\xF3n ante CFE (100% incluido)
\u2705 Estructura de aluminio anodizado anticorrosivo
\u2705 Instalaci\xF3n t\xE9cnica profesional certificada

\u26A0\uFE0F *NOTA IMPORTANTE:*
_Este presupuesto es una estimaci\xF3n aproximada basada en tu consumo reportado. El presupuesto real y final se confirmar\xE1 tras la visita t\xE9cnica Gratuita de nuestros ingenieros a tu domicilio._`;
    try {
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595.28, 841.89]);
      const { width, height } = page.getSize();
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontOblique = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
      const primaryOrange = rgb(0.92, 0.43, 0.12);
      const darkNavy = rgb(0.1, 0.15, 0.25);
      const lightBg = rgb(0.95, 0.96, 0.98);
      const textDark = rgb(0.2, 0.2, 0.2);
      let y = height - 50;
      page.drawRectangle({
        x: 0,
        y: height - 100,
        width,
        height: 100,
        color: darkNavy
      });
      page.drawText("O3 ENERGY M\xC9XICO", {
        x: 40,
        y: height - 45,
        size: 22,
        font: fontBold,
        color: primaryOrange
      });
      page.drawText("PRESUPUESTO PRELIMINAR DE SISTEMA FOTOVOLTAICO", {
        x: 40,
        y: height - 70,
        size: 11,
        font: fontRegular,
        color: rgb(1, 1, 1)
      });
      page.drawText(`Fecha: ${(/* @__PURE__ */ new Date()).toLocaleDateString("es-MX")}`, {
        x: width - 180,
        y: height - 45,
        size: 10,
        font: fontRegular,
        color: rgb(0.9, 0.9, 0.9)
      });
      y = height - 130;
      page.drawRectangle({
        x: 40,
        y: y - 70,
        width: width - 80,
        height: 75,
        color: lightBg,
        borderColor: rgb(0.85, 0.85, 0.85),
        borderWidth: 1
      });
      page.drawText("DATOS DEL CLIENTE Y PROYECTO", {
        x: 55,
        y: y - 18,
        size: 11,
        font: fontBold,
        color: darkNavy
      });
      page.drawText(`Cliente: ${dto.clientName}`, { x: 55, y: y - 38, size: 10, font: fontRegular, color: textDark });
      page.drawText(`Tel\xE9fono: +${dto.clientPhone}`, { x: 55, y: y - 55, size: 10, font: fontRegular, color: textDark });
      page.drawText(`Ubicaci\xF3n: ${dto.location || "Chihuahua, Chih."}`, { x: 300, y: y - 38, size: 10, font: fontRegular, color: textDark });
      page.drawText(`Tipo de Techo: ${dto.roofType || "Residencial / Losa"}`, { x: 300, y: y - 55, size: 10, font: fontRegular, color: textDark });
      y -= 105;
      page.drawRectangle({
        x: 40,
        y: y - 145,
        width: width - 80,
        height: 150,
        color: rgb(1, 1, 1),
        borderColor: primaryOrange,
        borderWidth: 1.5
      });
      page.drawText("RESUMEN DE COTIZACI\xD3N Y AHORRO ENERG\xC9TICO", {
        x: 55,
        y: y - 22,
        size: 12,
        font: fontBold,
        color: primaryOrange
      });
      page.drawText(`Consumo Reportado CFE: $${dto.monthlyBillMxn.toLocaleString("es-MX")} MXN/mes`, { x: 55, y: y - 48, size: 10, font: fontRegular, color: textDark });
      page.drawText(`Sistema Sugerido: ${dto.panelsCount} Paneles Solares (${dto.systemPowerKwp.toFixed(1)} kWp)`, { x: 55, y: y - 68, size: 11, font: fontBold, color: darkNavy });
      page.drawText(`Inversi\xF3n Total Estimada: ${formattedCost}`, { x: 55, y: y - 88, size: 12, font: fontBold, color: primaryOrange });
      page.drawText(`Ahorro Estimado Mensual: ${formattedMonthlySavings} (~90% reducci\xF3n)`, { x: 55, y: y - 108, size: 10, font: fontRegular, color: textDark });
      page.drawText(`Ahorro Estimado Anual: ${formattedAnnualSavings}`, { x: 55, y: y - 128, size: 10, font: fontRegular, color: textDark });
      y -= 175;
      page.drawText("LO QUE INCLUYE NUESTRO SERVICIO INTEGRAL:", { x: 40, y, size: 11, font: fontBold, color: darkNavy });
      y -= 20;
      const items = [
        "\u2022 Paneles solares de alta eficiencia Tier 1 con 25 a\xF1os de garant\xEDa",
        "\u2022 Microinversores inteligentes con monitoreo en tiempo real",
        "\u2022 Estrutura de aluminio anodizado altamente resistente y anticorrosiva",
        "\u2022 Tr\xE1mite 100% completo de interconexi\xF3n ante CFE",
        "\u2022 Instalaci\xF3n profesional por Ingenieros Certificados de O3 Energy"
      ];
      items.forEach((item) => {
        page.drawText(item, { x: 50, y, size: 9.5, font: fontRegular, color: textDark });
        y -= 18;
      });
      y -= 20;
      page.drawRectangle({
        x: 40,
        y: y - 60,
        width: width - 80,
        height: 65,
        color: rgb(0.99, 0.95, 0.9),
        borderColor: primaryOrange,
        borderWidth: 1
      });
      page.drawText("NOTA IMPORTANTE Y CONFIRMACI\xD3N DE VISITA T\xC9CNICA (SECCI\xD3N 5):", {
        x: 52,
        y: y - 18,
        size: 9.5,
        font: fontBold,
        color: primaryOrange
      });
      const noteText = "Este presupuesto es una estimaci\xF3n aproximada basada en tu consumo reportado. El presupuesto real\ny final se confirmar\xE1 tras la visita t\xE9cnica GRATUITA de nuestros Ingenieros al sitio para evaluar inclinaci\xF3n,\nsombras y trayectoria el\xE9ctrica.";
      const lines = noteText.split("\n");
      let noteY = y - 32;
      lines.forEach((l) => {
        page.drawText(l, { x: 52, y: noteY, size: 8.5, font: fontOblique, color: darkNavy });
        noteY -= 12;
      });
      page.drawText("O3 Energy M\xE9xico \u2014 L\xEDderes en Ingenier\xEDa Fotovoltaica | www.o3energy.mx", {
        x: 100,
        y: 25,
        size: 8.5,
        font: fontRegular,
        color: rgb(0.5, 0.5, 0.5)
      });
      const pdfBytes = await pdfDoc.save();
      const pdfBuffer = Buffer.from(pdfBytes);
      const fileName = `Cotizacion_Solar_${dto.panelsCount}_Paneles_${dto.clientPhone.slice(-4)}.pdf`;
      let pdfUrl = `${AppConfig.mediaBaseUrl}/${fileName}`;
      try {
        const publicDir = path.join(process.cwd(), "public", "images");
        if (!fs.existsSync(publicDir)) {
          fs.mkdirSync(publicDir, { recursive: true });
        }
        const filePath = path.join(publicDir, fileName);
        fs.writeFileSync(filePath, pdfBuffer);
      } catch (e) {
        logger.warn("[QuotePdfService] Local public write warning:", e.message);
      }
      try {
        if (getApps().length > 0) {
          const storage = getStorage();
          const bucket = storage.bucket();
          const fileRef = bucket.file(`cotizaciones/${fileName}`);
          await fileRef.save(pdfBuffer, { contentType: "application/pdf", public: true });
          pdfUrl = `https://storage.googleapis.com/${bucket.name}/cotizaciones/${fileName}`;
          logger.info(`[QuotePdfService] Uploaded PDF to Cloud Storage: ${pdfUrl}`);
        }
      } catch (cloudErr) {
        logger.info("[QuotePdfService] Using local media URL fallback for PDF.");
      }
      logger.info(`[QuotePdfService] Generated dynamic PDF successfully: ${pdfUrl}`);
      return {
        success: true,
        pdfUrl,
        pdfBuffer,
        textSummary
      };
    } catch (error) {
      logger.error("Error generating Quote PDF in QuotePdfService:", error);
      return {
        success: false,
        textSummary
      };
    }
  }
};

// server/application/orchestration/SofiaFlowOrchestrator.ts
var SofiaFlowOrchestrator = class {
  constructor(conversationRepo, leadRepo, quoteEngine2, llmProvider2, sendWhatsAppText, emailService2) {
    this.conversationRepo = conversationRepo;
    this.leadRepo = leadRepo;
    this.quoteEngine = quoteEngine2;
    this.llmProvider = llmProvider2;
    this.sendWhatsAppText = sendWhatsAppText;
    this.emailService = emailService2;
  }
  async processMessage(input) {
    const { tenantId, phone, userName, messageText } = input;
    const conv = await this.conversationRepo.findByPhone(tenantId, phone);
    if (!conv.state.completedSteps) conv.state.completedSteps = [];
    if (!conv.state.mediaSentFlags) conv.state.mediaSentFlags = {};
    if (userName && userName !== "Cliente" && conv.nombre === "Cliente") {
      conv.nombre = userName;
    }
    if (conv.botDisabled) {
      logger.info(`[SofiaFlowOrchestrator] Bot disabled for ${phone}. Skipping automated response.`);
      return { replyText: "", nextStep: 6, botDisabled: true };
    }
    const currentStepInt = this.phaseToStepInt(conv.state.phase);
    const promptCtx = {
      phone,
      userName: conv.nombre,
      currentStep: currentStepInt,
      extractedData: {
        billAmount: conv.state.monthlyBill,
        roofType: conv.state.roofType,
        meterDistance: conv.state.meterDistance,
        extraLoads: conv.state.extraLoads,
        location: conv.state.location,
        ownership: conv.state.isOwner ? "Propio" : void 0
      },
      quoteConsentRequested: conv.state.quoteConsentRequested,
      quoteConsentGiven: conv.state.quoteConsentGiven,
      botDisabled: conv.botDisabled,
      latestUserMessage: messageText,
      historySummary: conv.messages.slice(-6).map((m) => `${m.sender}: ${m.text}`).join("\n")
    };
    const { systemPrompt, userContent } = SofiaPromptBuilder.buildPrompt(promptCtx);
    const rawLlmOutput = await this.llmProvider.complete(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ],
      [],
      0.2
    );
    const parsed = SofiaPromptBuilder.parseResponse(rawLlmOutput.text || "");
    const mediaSent = [];
    let finalReply = parsed.message_to_user;
    if (parsed.extracted_data) {
      if (parsed.extracted_data.client_name && conv.nombre === "Cliente") {
        conv.nombre = parsed.extracted_data.client_name;
      }
      if (parsed.extracted_data.bill_amount) {
        conv.state.monthlyBill = parsed.extracted_data.bill_amount;
        conv.montoRecibo = `$${parsed.extracted_data.bill_amount} MXN`;
      }
      if (parsed.extracted_data.roof_type) {
        conv.state.roofType = parsed.extracted_data.roof_type;
      }
      if (parsed.extracted_data.ownership) {
        conv.state.isOwner = parsed.extracted_data.ownership.toLowerCase().includes("propi") || parsed.extracted_data.ownership.toLowerCase().includes("propia");
      }
      if (parsed.extracted_data.meter_distance) {
        conv.state.meterDistance = parsed.extracted_data.meter_distance;
      }
      if (parsed.extracted_data.location) {
        conv.state.location = parsed.extracted_data.location;
      }
    }
    const lowerMessage = messageText.toLowerCase().trim();
    const explicitAffirmative = ["si", "s\xED", "adelante", "por favor", "mu\xE9stramela", "muestramela", "ver cotizacion", "ver cotizaci\xF3n", "claro"].some((k) => lowerMessage === k || lowerMessage.startsWith(k));
    if (parsed.quote_consent_requested) {
      conv.state.quoteConsentRequested = true;
    }
    if (parsed.quote_consent_given || conv.state.quoteConsentRequested && explicitAffirmative) {
      conv.state.quoteConsentGiven = true;
    }
    const isQuoteNotYetSent = !conv.state.completedSteps.includes("QUOTE_SENT");
    if (conv.state.quoteConsentGiven && isQuoteNotYetSent && conv.state.monthlyBill) {
      const bill = conv.state.monthlyBill;
      const calcResult = this.quoteEngine.calculate(bill);
      const quoteDto = {
        clientName: conv.nombre || userName || "Cliente",
        clientPhone: phone,
        monthlyBillMxn: bill,
        panelsCount: calcResult.panels,
        systemPowerKwp: calcResult.systemPowerKw,
        totalCostMxn: calcResult.estimatedCost,
        monthlySavingsMxn: calcResult.monthlySavings,
        annualSavingsMxn: calcResult.annualSavings,
        roofType: conv.state.roofType,
        location: conv.state.location
      };
      const pdfResult = await QuotePdfService.generateQuote(quoteDto);
      finalReply = `${pdfResult.textSummary}

${parsed.message_to_user}`;
      conv.state.completedSteps.push("QUOTE_SENT");
    }
    const shouldSendInstalacion = (parsed.media_to_send === "INSTALACION_PROFESIONAL" || parsed.next_step === 2 || parsed.next_step === 3) && !conv.state.mediaSentFlags.instalacionProfessional;
    if (shouldSendInstalacion) {
      const imgUrl = `${AppConfig.mediaBaseUrl}/INSTALACION_PROFESIONAL.jpeg`;
      mediaSent.push(imgUrl);
      conv.state.mediaSentFlags.instalacionProfessional = true;
    }
    const shouldSendFinanciamiento = (parsed.media_to_send === "FINANCIAMIENTO" || conv.state.quoteConsentGiven && parsed.next_step >= 4) && !conv.state.mediaSentFlags.financiamiento;
    if (shouldSendFinanciamiento) {
      const imgUrl = `${AppConfig.mediaBaseUrl}/FINANCIAMIENTO.jpeg`;
      mediaSent.push(imgUrl);
      conv.state.mediaSentFlags.financiamiento = true;
    }
    let isHandoff = parsed.trigger_human_handoff;
    if (messageText.toLowerCase().includes("asesor") || messageText.toLowerCase().includes("humano") || messageText.toLowerCase().includes("agente")) {
      isHandoff = true;
    }
    if (isHandoff) {
      conv.botDisabled = true;
      conv.state.phase = "HUMAN_HANDOFF";
      finalReply = `\xA1Con mucho gusto! En un momento uno de nuestros asesores especializados de O3 Energy se pondr\xE1 en contacto contigo directamente a trav\xE9s de este chat para brindarte atenci\xF3n personalizada. \u2600\uFE0F

\xA1Que tengas un excelente d\xEDa!`;
      await this.triggerLeadHandoff(conv, phone, userName || conv.nombre, parsed.handoff_reason || "Solicitud de cliente");
    } else {
      conv.state.phase = this.stepIntToPhase(parsed.next_step);
    }
    conv.messages.push({ sender: "user", text: messageText, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    conv.messages.push({ sender: "bot", text: finalReply, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    conv.lastMessageAt = (/* @__PURE__ */ new Date()).toISOString();
    await this.conversationRepo.save(conv);
    return {
      replyText: finalReply,
      nextStep: parsed.next_step,
      botDisabled: conv.botDisabled,
      mediaSent: mediaSent.length > 0 ? mediaSent : void 0
    };
  }
  phaseToStepInt(phase) {
    switch (phase) {
      case "GREETING":
        return 1;
      case "QUALIFICATION":
        return 2;
      case "TECHNICAL_SURVEY":
        return 3;
      case "QUOTATION":
        return 4;
      case "FINANCING":
        return 5;
      case "CLOSING":
      case "HUMAN_HANDOFF":
      case "LEAD_GENERATED":
        return 6;
      default:
        return 1;
    }
  }
  stepIntToPhase(step) {
    switch (step) {
      case 1:
        return "GREETING";
      case 2:
        return "QUALIFICATION";
      case 3:
        return "TECHNICAL_SURVEY";
      case 4:
        return "QUOTATION";
      case 5:
        return "FINANCING";
      case 6:
        return "CLOSING";
      default:
        return "GREETING";
    }
  }
  async triggerLeadHandoff(conv, phone, name, reason) {
    try {
      const lead = {
        id: phone,
        tenantId: conv.tenantId,
        phone,
        nombre: name,
        montoRecibo: `$${conv.state.monthlyBill || 0} MXN`,
        sistemaEstimado: `${conv.state.roofType || "Residencial"}`,
        costoEstimado: "Cotizaci\xF3n solicitada",
        leadScore: 85,
        status: "pending_review",
        privateNotes: `Lead derivado a asesor humano. Razon: ${reason}`,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await this.leadRepo.save(lead);
      await this.emailService.sendLeadNotification({
        leadName: name,
        phone,
        monthlyBill: conv.state.monthlyBill || 0,
        notes: `Solicitud de atenci\xF3n humana en WhatsApp: ${reason}`
      });
      logger.info(`[SofiaFlowOrchestrator] Lead handoff email sent for ${phone}`);
    } catch (err) {
      logger.error(`[SofiaFlowOrchestrator] Lead handoff email trigger failed:`, err);
    }
  }
};

// server/infrastructure/web/container.ts
import { getApps as getApps2 } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import nodemailer from "nodemailer";
var quoteEngine = new SolarQuoteEngine();
var llmProvider = new GroqProvider();
var emailService = {
  async sendLeadNotification(leadData) {
    const { server, port, user, pass, salesEmail } = AppConfig.smtp;
    if (!pass) {
      logger.info("[Email SIM] \u2192 Sales Team Lead Notification:", leadData);
      return true;
    }
    try {
      const transporter = nodemailer.createTransport({
        host: server,
        port,
        secure: port === 465,
        auth: { user, pass }
      });
      await transporter.sendMail({
        from: `"Sof\xEDa IA - O3 Energy" <${user}>`,
        to: salesEmail,
        subject: `\u{1F525} NUEVO LEAD CALIFICADO SOLAR: ${leadData.leadName} (+${leadData.phone})`,
        text: `Se ha derivado un nuevo prospecto calificado desde WhatsApp:

Cliente: ${leadData.leadName}
Tel\xE9fono: +${leadData.phone}
Recibo CFE Estimado: $${leadData.monthlyBill} MXN
Notas: ${leadData.notes || "Ninguna"}

Favor de atender este chat de inmediato.`
      });
      logger.info(`[EmailService] Notification sent for lead +${leadData.phone}`);
      return true;
    } catch (err) {
      logger.error("[EmailService] Failed to send email:", err);
      return false;
    }
  }
};
async function sendWhatsAppMessage(phone, text) {
  const { accessToken, phoneNumberId } = AppConfig.meta;
  if (!accessToken) {
    logger.info(`[WhatsApp SIM] \u2192 +${phone}: ${text.substring(0, 80)}...`);
    return true;
  }
  if (phoneNumberId) {
    try {
      const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: phone,
          type: "text",
          text: { preview_url: false, body: text }
        })
      });
      const data = await res.json();
      if (!res.ok) {
        logger.error("[WhatsApp] Send failed", data);
        return false;
      }
      logger.info(`[WhatsApp] Sent text successfully to +${phone}`, { messageId: data.messages?.[0]?.id });
      return true;
    } catch (err) {
      logger.error("[WhatsApp] Exception", { error: err.message });
      return false;
    }
  }
  return false;
}
async function sendWhatsAppMedia(phone, mediaUrl, caption) {
  const { accessToken, phoneNumberId } = AppConfig.meta;
  if (!accessToken) {
    logger.info(`[WhatsApp SIM Media] \u2192 +${phone}: Link=${mediaUrl}`);
    return true;
  }
  if (phoneNumberId) {
    try {
      const isPdf = mediaUrl.endsWith(".pdf");
      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: phone,
        type: isPdf ? "document" : "image"
      };
      if (isPdf) {
        payload.document = { link: mediaUrl, caption: caption || "Cotizaci\xF3n Solar O3 Energy" };
      } else {
        payload.image = { link: mediaUrl, caption: caption || "" };
      }
      const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        logger.error("[WhatsApp Media] Send failed", data);
        return false;
      }
      logger.info(`[WhatsApp Media] Sent successfully to +${phone}`, { mediaUrl });
      return true;
    } catch (err) {
      logger.error("[WhatsApp Media] Exception", { error: err.message });
      return false;
    }
  }
  return false;
}
function getRepos() {
  try {
    if (getApps2().length > 0) {
      const db2 = getFirestore();
      logger.info("[DI] Using Firestore repositories (multi-tenant)");
      return {
        convRepo: new FirestoreConversationRepository(db2),
        leadRepo: new FirestoreLeadRepository(db2)
      };
    }
  } catch (e) {
    logger.warn("[DI] Could not get Firestore, falling back to InMemory", { error: e.message });
  }
  logger.warn("[DI] Firestore not available \u2014 using InMemory repositories");
  return {
    convRepo: new InMemoryConversationRepository(),
    leadRepo: new InMemoryLeadRepository()
  };
}
var _convRepo;
var _leadRepo;
function initRepositories(db2) {
  if (db2) {
    logger.info("[DI] initRepositories: Using Firestore repositories (multi-tenant)");
    _convRepo = new FirestoreConversationRepository(db2);
    _leadRepo = new FirestoreLeadRepository(db2);
  } else {
    logger.warn("[DI] initRepositories: Firestore not available \u2014 using InMemory repositories");
    _convRepo = new InMemoryConversationRepository();
    _leadRepo = new InMemoryLeadRepository();
  }
}
function buildReceiveMessageUseCase() {
  const repos = _convRepo && _leadRepo ? { convRepo: _convRepo, leadRepo: _leadRepo } : getRepos();
  const flowOrchestrator = new SofiaFlowOrchestrator(
    repos.convRepo,
    repos.leadRepo,
    quoteEngine,
    llmProvider,
    sendWhatsAppMessage,
    emailService
  );
  return new ReceiveMessageUseCase(
    repos.convRepo,
    flowOrchestrator,
    sendWhatsAppMessage,
    sendWhatsAppMedia
  );
}

// server/infrastructure/web/v2Router.ts
var v2Router = Router();
v2Router.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "2.0.0", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
});
v2Router.get("/ready", (_req, res) => {
  const groqConfigured = !!AppConfig.groq.apiKey;
  const metaConfigured = !!AppConfig.meta.accessToken;
  res.status(groqConfigured ? 200 : 503).json({
    ready: groqConfigured,
    services: {
      groq: groqConfigured ? "ok" : "missing_api_key",
      whatsapp: metaConfigured ? "ok" : "simulation_mode",
      smtp: !!AppConfig.smtp.pass ? "ok" : "simulation_mode"
    }
  });
});
v2Router.get("/whatsapp-webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === AppConfig.meta.verifyToken) {
    logger.info("[v2 Webhook] Meta verification OK");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});
v2Router.post("/whatsapp-webhook", async (req, res) => {
  let phone = "", text = "", name = "Cliente";
  const body = req.body;
  try {
    if (body.entry?.[0]?.changes?.[0]?.value) {
      const val = body.entry[0].changes[0].value;
      const eventType = val.messages ? "message" : val.statuses ? "status" : "other";
      logger.info("[v2 Webhook] WhatsApp event received", { eventType });
      if (val.messages?.[0]) {
        const msg = val.messages[0];
        phone = msg.from;
        text = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "";
        name = val.contacts?.[0]?.profile?.name || "Cliente WhatsApp";
      } else {
        if (val.statuses?.[0]) {
          logger.info("[v2 Webhook] Status update", val.statuses[0]);
        }
        return res.status(200).json({ status: "received" });
      }
    } else if (body.entry?.[0]?.messaging?.[0]) {
      const messaging = body.entry[0].messaging[0];
      if (messaging.message?.is_echo) {
        logger.info("[v2 Webhook] Ignoring Messenger echo");
        return res.status(200).json({ status: "received" });
      }
      if (messaging.message) {
        phone = messaging.sender?.id || "";
        text = messaging.message.text || "";
        name = "Cliente Messenger";
      } else if (messaging.postback) {
        phone = messaging.sender?.id || "";
        text = messaging.postback.title || messaging.postback.payload || "";
        name = "Cliente Messenger";
      } else {
        return res.status(200).json({ status: "received" });
      }
    } else if (body.From && body.Body) {
      phone = body.From.replace("whatsapp:", "");
      text = body.Body;
      name = body.ProfileName || "Cliente Twilio";
    } else if (body.phone && body.text) {
      phone = body.phone;
      text = body.text;
      name = body.name || "Cliente Simulado";
    }
    if (!phone || !text) {
      logger.warn("[v2 Webhook] Missing phone or text, skipping");
      return res.status(200).json({ status: "received" });
    }
    const useCase = buildReceiveMessageUseCase();
    await useCase.execute({ phone, text, name });
  } catch (err) {
    logger.error("[v2 Webhook] Unhandled error", { error: err.message, stack: err.stack });
  }
  return res.status(200).json({ status: "received" });
});
v2Router.get("/chats", async (req, res) => {
  const tenantId = req.query.tenantId || AppConfig.tenant.defaultId;
  try {
    const chats = await _convRepo.findAll(tenantId);
    return res.json(chats);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
v2Router.post("/chats/:phone/toggle-bot", async (req, res) => {
  const { phone } = req.params;
  const { bot_disabled } = req.body;
  const tenantId = req.body.tenantId || AppConfig.tenant.defaultId;
  try {
    const conv = await _convRepo.findByPhone(tenantId, phone);
    conv.botDisabled = bot_disabled;
    await _convRepo.save(conv);
    return res.json({ success: true, conv });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
v2Router.post("/chats/:phone/message", async (req, res) => {
  const { phone } = req.params;
  const { text } = req.body;
  const tenantId = req.body.tenantId || AppConfig.tenant.defaultId;
  if (!text) return res.status(400).json({ error: "Text is required" });
  try {
    const conv = await _convRepo.findByPhone(tenantId, phone);
    conv.messages.push({ sender: "agent", text, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    conv.lastMessageAt = (/* @__PURE__ */ new Date()).toISOString();
    conv.botDisabled = true;
    await _convRepo.save(conv);
    const { accessToken, phoneNumberId } = AppConfig.meta;
    if (accessToken && phoneNumberId) {
      await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "text", text: { preview_url: false, body: text } })
      });
    }
    return res.json({ success: true, conv });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
v2Router.post("/copilot/query", async (req, res) => {
  const { question, history } = req.body;
  const tenantId = req.body.tenantId || AppConfig.tenant.defaultId;
  if (!question) return res.status(400).json({ error: "Falta la pregunta" });
  try {
    const leads = await _leadRepo.findAll(tenantId);
    const chats = await _convRepo.findAll(tenantId);
    const databaseContext = {
      qualified_leads: leads,
      chats_metadata: chats.map((c) => ({ phone: c.phone, nombre: c.nombre, phase: c.state.phase, botDisabled: c.botDisabled, lastMessageAt: c.lastMessageAt })),
      current_time: (/* @__PURE__ */ new Date()).toISOString(),
      metadata: { total_leads: leads.length, total_chats: chats.length }
    };
    const systemInstruction = `Eres el Copiloto de Ventas. Responde analizando: ${JSON.stringify(databaseContext)}. Usa Markdown y pesos MXN.`;
    const chatHistory = [
      { role: "system", content: systemInstruction },
      ...(history || []).map((m) => ({ role: m.sender === "user" ? "user" : "assistant", content: m.text })),
      { role: "user", content: question }
    ];
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${AppConfig.groq.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: AppConfig.groq.model, messages: chatHistory, temperature: 0.2 })
    });
    const data = await response.json();
    return res.json({ answer: data.choices?.[0]?.message?.content || "" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
v2Router.get("/leads", async (req, res) => {
  const tenantId = req.query.tenantId || AppConfig.tenant.defaultId;
  try {
    const leads = await _leadRepo.findAll(tenantId);
    return res.json(leads);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
v2Router.post("/leads/:id/contacted", async (req, res) => {
  const { id } = req.params;
  const tenantId = req.body.tenantId || AppConfig.tenant.defaultId;
  try {
    await _leadRepo.updateStatus(tenantId, id, "contacted");
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
v2Router.post("/leads/:id/notes", async (req, res) => {
  const { id } = req.params;
  const { private_notes, tenantId } = req.body;
  const tenant = tenantId || AppConfig.tenant.defaultId;
  try {
    await _leadRepo.updateNotes(tenant, id, private_notes);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
v2Router.post("/reset-demo", async (req, res) => {
  return res.json({ success: true });
});

// server/infrastructure/ai/LLMProvider.ts
async function callGroq(systemInstruction, messages, temperature = 0.7) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY no configurada en variables de entorno.");
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      temperature,
      messages: [
        { role: "system", content: systemInstruction },
        ...messages
      ]
    })
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Groq error ${response.status}: ${err?.error?.message || response.statusText}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}
async function callGemini(systemInstruction, messages, temperature = 0.7) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY no configurada. Fallback no disponible.");
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: { temperature }
      })
    }
  );
  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Gemini error ${response.status}: ${err?.error?.message || response.statusText}`);
  }
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}
async function callLLM(systemInstruction, messages, temperature = 0.7) {
  try {
    const text = await callGroq(systemInstruction, messages, temperature);
    console.log("[LLMProvider] \u2705 Respuesta generada con Groq (LLaMA 3.3 70B)");
    return { text, provider: "groq" };
  } catch (groqErr) {
    console.warn(`[LLMProvider] \u26A0\uFE0F Groq fall\xF3: ${groqErr.message}. Intentando fallback a Gemini...`);
  }
  try {
    const text = await callGemini(systemInstruction, messages, temperature);
    console.log("[LLMProvider] \u2705 Respuesta generada con Gemini (fallback activado)");
    return { text, provider: "gemini" };
  } catch (geminiErr) {
    console.error(`[LLMProvider] \u274C Ambos proveedores fallaron. Gemini: ${geminiErr.message}`);
    throw new Error(
      "El motor de IA no est\xE1 disponible en este momento. Por favor verifica las API Keys en las variables de entorno del servidor."
    );
  }
}

// api_src/index.ts
var firebaseConfig = {
  projectId: "agente-comercial-solar",
  appId: "1:615897776902:web:1db49554bc7c0699755487",
  apiKey: "AIzaSyCMJtiqXdtrt7U-u4M0-PHljFCBQKJwp9g",
  authDomain: "agente-comercial-solar.firebaseapp.com",
  firestoreDatabaseId: "(default)",
  storageBucket: "agente-comercial-solar.firebasestorage.app",
  messagingSenderId: "615897776902"
};
var app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
var db = null;
var isInMemory = false;
var inMemoryChats = {};
var inMemoryLeads = {};
function initFirebase() {
  if (getApps3().length > 0) {
    const dbId = firebaseConfig.firestoreDatabaseId;
    db = dbId && dbId !== "(default)" ? getFirestore2(dbId) : getFirestore2();
    return;
  }
  try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      initializeApp({
        credential: cert(serviceAccount),
        projectId: firebaseConfig.projectId
      });
      console.log("Firebase Admin SDK initialized from FIREBASE_SERVICE_ACCOUNT_JSON env var");
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      initializeApp({ projectId: firebaseConfig.projectId });
      console.log("Firebase Admin SDK initialized using GOOGLE_APPLICATION_CREDENTIALS");
    } else {
      console.warn("No Firebase Admin credentials found. Falling back to in-memory mode.");
      isInMemory = true;
      return;
    }
    const dbId = firebaseConfig.firestoreDatabaseId;
    db = dbId && dbId !== "(default)" ? getFirestore2(dbId) : getFirestore2();
    console.log(`Firebase Admin SDK connected. Database ID: ${dbId || "(default)"}`);
  } catch (error) {
    console.warn("Firebase Admin SDK failed to initialize. Falling back to in-memory mode:", error);
    isInMemory = true;
  }
  if (!isInMemory && db) {
    initRepositories(db);
  } else {
    initRepositories(null);
  }
}
initFirebase();
app.use("/api/v2", v2Router);
async function getChatDoc(phone) {
  if (isInMemory) {
    if (!inMemoryChats[phone]) {
      inMemoryChats[phone] = {
        id: phone,
        phone,
        nombre: "Cliente",
        botDisabled: false,
        messages: [],
        lastMessageAt: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    return inMemoryChats[phone];
  }
  const docRef = db.collection("tenants/o3energy_mexico/chats").doc(phone);
  const doc = await docRef.get();
  if (!doc.exists) {
    const newChat = { phone, nombre: "Cliente", botDisabled: false, messages: [], lastMessageAt: (/* @__PURE__ */ new Date()).toISOString() };
    await docRef.set(newChat);
    return { id: phone, ...newChat };
  }
  return { id: doc.id, ...doc.data() };
}
async function updateChatDoc(phone, data) {
  if (isInMemory) {
    inMemoryChats[phone] = { ...inMemoryChats[phone], ...data };
    return;
  }
  await db.collection("tenants/o3energy_mexico/chats").doc(phone).set(data, { merge: true });
}
async function sendWhatsAppMessage2(phone, text) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    console.log(`[WHATSAPP SIMULACI\xD3N] Para +${phone}: ${text.substring(0, 60)}...`);
    return true;
  }
  try {
    const response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "text", text: { preview_url: false, body: text } })
    });
    const data = await response.json();
    if (response.ok) {
      console.log(`[WHATSAPP OK] Mensaje a +${phone}`);
      return true;
    }
    console.error("[WHATSAPP ERROR]", data);
    return false;
  } catch (err) {
    console.error("[WHATSAPP EXCEPCI\xD3N]", err);
    return false;
  }
}
async function callGroqAPI(systemInstruction, messages, temperature = 0.7) {
  const result = await callLLM(systemInstruction, messages, temperature);
  return result.text;
}
app.use(["/whatsapp-webhook", "/api/whatsapp-webhook"], (req, res, next) => {
  req.url = "/whatsapp-webhook";
  v2Router(req, res, next);
});
app.get("/api/chats", async (_req, res) => {
  try {
    if (isInMemory) return res.json(Object.values(inMemoryChats));
    const snapshot = await db.collection("tenants/o3energy_mexico/chats").orderBy("lastMessageAt", "desc").get();
    return res.json(snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        lastMessageAt: data.lastMessageAt || data.lastMessageAt,
        botDisabled: data.botDisabled || data.botDisabled,
        montoRecibo: data.montoRecibo || data.montoRecibo,
        sistemaEstimado: data.sistemaEstimado || data.sistemaEstimado,
        costoEstimado: data.costoEstimado || data.costoEstimado
      };
    }));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.post("/api/chats/:phone/toggle-bot", async (req, res) => {
  const { phone } = req.params;
  const { botDisabled } = req.body;
  try {
    const chat = await getChatDoc(phone);
    chat.botDisabled = botDisabled;
    await updateChatDoc(phone, chat);
    return res.json({ success: true, chat });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.post("/api/chats/:phone/message", async (req, res) => {
  const { phone } = req.params;
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Text is required" });
  try {
    const chat = await getChatDoc(phone);
    chat.messages.push({ sender: "agent", text, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    chat.lastMessageAt = (/* @__PURE__ */ new Date()).toISOString();
    chat.botDisabled = true;
    await updateChatDoc(phone, chat);
    await sendWhatsAppMessage2(phone, text);
    return res.json({ success: true, chat });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.get("/api/leads", async (_req, res) => {
  try {
    if (isInMemory) return res.json(Object.values(inMemoryLeads));
    const snapshot = await db.collection("tenants/o3energy_mexico/qualified_leads").orderBy("createdAt", "desc").get();
    return res.json(snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        createdAt: data.createdAt || data.createdAt,
        montoRecibo: data.montoRecibo || data.montoRecibo,
        sistemaEstimado: data.sistemaEstimado || data.sistemaEstimado,
        costoEstimado: data.costoEstimado || data.costoEstimado,
        privateNotes: data.privateNotes || data.privateNotes
      };
    }));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.post("/api/copilot/query", async (req, res) => {
  const { question, history } = req.body;
  if (!question) return res.status(400).json({ error: "Falta la pregunta" });
  try {
    let leadsList = [], chatsList = [];
    if (isInMemory) {
      leadsList = Object.values(inMemoryLeads);
      chatsList = Object.values(inMemoryChats).map((c) => ({ id: c.id, phone: c.phone, nombre: c.nombre, botDisabled: c.botDisabled, montoRecibo: c.montoRecibo, sistemaEstimado: c.sistemaEstimado, costoEstimado: c.costoEstimado, message_count: c.messages?.length || 0, lastMessageAt: c.lastMessageAt }));
    } else {
      const ls = await db.collection("tenants/o3energy_mexico/qualified_leads").orderBy("createdAt", "desc").get();
      leadsList = ls.docs.map((d) => ({ id: d.id, ...d.data() }));
      const cs = await db.collection("tenants/o3energy_mexico/chats").orderBy("lastMessageAt", "desc").get();
      chatsList = cs.docs.map((d) => {
        const data = d.data();
        return { id: d.id, phone: data.phone, nombre: data.nombre, botDisabled: data.botDisabled, montoRecibo: data.montoRecibo, sistemaEstimado: data.sistemaEstimado, costoEstimado: data.costoEstimado, message_count: data.messages?.length || 0, lastMessageAt: data.lastMessageAt };
      });
    }
    const databaseContext = { qualified_leads: leadsList, chats_metadata: chatsList, current_time: (/* @__PURE__ */ new Date()).toISOString(), metadata: { total_leads: leadsList.length, total_chats: chatsList.length, pending_leads: leadsList.filter((l) => l.status === "pending_review").length, contacted_leads: leadsList.filter((l) => l.status === "contacted").length } };
    const systemInstruction = `Eres el Copiloto Inteligente de Base de Datos de Ventas de "O3 Energy M\xE9xico". Responde con precisi\xF3n anal\xEDtica usando \xDANICAMENTE los datos:
${JSON.stringify(databaseContext, null, 2)}
Usa formato Markdown con tablas y negritas. Montos en pesos mexicanos. Si est\xE1 vac\xEDo, sugiere usar el Simulador de Webhook.`;
    try {
      const chatHistory = [
        ...(history || []).map((m) => ({
          role: m.sender === "user" ? "user" : "assistant",
          content: m.text
        })),
        { role: "user", content: question }
      ];
      const answer = await callGroqAPI(systemInstruction, chatHistory, 0.1);
      return res.json({ answer });
    } catch (aiErr) {
      console.error("Groq Copilot error:", aiErr);
      return res.status(500).json({ error: aiErr.message || "Error en el Copiloto" });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.post("/api/leads/:id/contacted", async (req, res) => {
  const { id } = req.params;
  try {
    if (isInMemory) {
      if (inMemoryLeads[id]) inMemoryLeads[id].status = "contacted";
      return res.json({ success: true });
    }
    await db.collection("tenants/o3energy_mexico/qualified_leads").doc(id).update({ status: "contacted" });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.post("/api/leads/:id/notes", async (req, res) => {
  const { id } = req.params;
  const { privateNotes } = req.body;
  try {
    if (isInMemory) {
      if (inMemoryLeads[id]) inMemoryLeads[id].privateNotes = privateNotes;
      return res.json({ success: true, privateNotes });
    }
    await db.collection("tenants/o3energy_mexico/qualified_leads").doc(id).set({ privateNotes }, { merge: true });
    return res.json({ success: true, privateNotes });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.post("/api/reset-demo", async (_req, res) => {
  try {
    if (isInMemory) {
      Object.keys(inMemoryChats).forEach((k) => delete inMemoryChats[k]);
      Object.keys(inMemoryLeads).forEach((k) => delete inMemoryLeads[k]);
    } else {
      const chatsSnap = await db.collection("tenants/o3energy_mexico/chats").get();
      for (const doc of chatsSnap.docs) await doc.ref.delete();
      const leadsSnap = await db.collection("tenants/o3energy_mexico/qualified_leads").get();
      for (const doc of leadsSnap.docs) await doc.ref.delete();
    }
    return res.json({ success: true, message: "Datos reseteados." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
var index_default = app;
export {
  index_default as default
};
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Vercel Serverless Function entry point.
 * Architecture: Strangler Pattern — v1 routes remain for backward compat.
 * All NEW traffic should use /api/v2/* routes (Clean Architecture).
 * v1 will be deprecated once v2 is validated in production.
 */

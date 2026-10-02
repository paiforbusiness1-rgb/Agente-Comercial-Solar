// api_src/index.ts
import express from "express";
import { initializeApp, getApps as getApps5, cert } from "firebase-admin/app";
import { getFirestore as getFirestore4 } from "firebase-admin/firestore";
import nodemailer3 from "nodemailer";

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
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
      waAgentTemplateName: process.env.WA_AGENT_TEMPLATE_NAME || "notificacion_nuevo_prospecto"
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
  },
  get auth() {
    return {
      adminEmail: process.env.ADMIN_EMAIL || "admin@o3energy.mx",
      adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || "",
      jwtSecret: process.env.JWT_SECRET || "fallback-super-secret-jwt-key-minimum-32-chars-entropy-2026",
      tokenExpiresInHours: parseInt(process.env.JWT_EXPIRES_IN_HOURS || "8", 10)
    };
  },
  get agents() {
    return {
      fallbackEmail: process.env.FALLBACK_AGENT_EMAIL || "ventas@o3energy.mx",
      fallbackWhatsapp: process.env.FALLBACK_AGENT_WA || ""
    };
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
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        status: "active"
      };
    }
    return chatsStore[key];
  }
  async save(conversation) {
    const key = `${conversation.tenantId}::${conversation.phone}`;
    if (!conversation.status) conversation.status = "active";
    chatsStore[key] = conversation;
  }
  async findAll(tenantId) {
    return Object.values(chatsStore).filter((c) => c.tenantId === tenantId && c.status !== "deleted");
  }
  async findTrash(tenantId) {
    return Object.values(chatsStore).filter((c) => c.tenantId === tenantId && c.status === "deleted");
  }
  async softDelete(tenantId, phone, deletedBy) {
    const conv = await this.findByPhone(tenantId, phone);
    if (!conv) return false;
    conv.status = "deleted";
    conv.deletedAt = (/* @__PURE__ */ new Date()).toISOString();
    conv.deletedBy = deletedBy;
    await this.save(conv);
    return true;
  }
  async restore(tenantId, phone) {
    const conv = await this.findByPhone(tenantId, phone);
    if (!conv) return false;
    conv.status = "active";
    conv.deletedAt = void 0;
    conv.deletedBy = void 0;
    await this.save(conv);
    return true;
  }
  async purgeExpiredTrash(tenantId, daysRetention = 30) {
    const cutoffMs = Date.now() - daysRetention * 24 * 60 * 60 * 1e3;
    let purgedCount = 0;
    Object.keys(chatsStore).forEach((key) => {
      const conv = chatsStore[key];
      if (conv.tenantId === tenantId && conv.status === "deleted") {
        const deletedTime = conv.deletedAt ? new Date(conv.deletedAt).getTime() : 0;
        if (daysRetention === 0 || deletedTime <= cutoffMs) {
          delete chatsStore[key];
          purgedCount++;
        }
      }
    });
    return purgedCount;
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
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          status: "active"
        };
        await docRef.set(conv);
        return conv;
      }
      return { id: doc.id, status: "active", ...doc.data() };
    } catch (err) {
      logger.warn("[FirestoreConversationRepo] Fallback to In-Memory due to Firestore error", { error: err.message });
      return inMemoryConvFallback.findByPhone(tenantId, phone);
    }
  }
  async save(conversation) {
    if (!conversation.status) conversation.status = "active";
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
      const all = snap.docs.map((d) => ({
        id: d.id,
        phone: d.data().phone || d.id,
        ...d.data()
      }));
      return all.filter((c) => c.status !== "deleted");
    } catch (err) {
      logger.warn("[FirestoreConversationRepo] Fallback to In-Memory for findAll", { error: err.message });
      return inMemoryConvFallback.findAll(tenantId);
    }
  }
  async findTrash(tenantId) {
    try {
      const deletedSnap = await this.db.collection(`tenants/${tenantId}/deleted_chats`).get();
      const archived = deletedSnap.docs.map((d) => ({
        id: d.id,
        phone: d.data().phone || d.id,
        ...d.data()
      }));
      const legacySnap = await this.db.collection(`tenants/${tenantId}/chats`).where("status", "==", "deleted").get();
      const legacy = legacySnap.docs.map((d) => ({
        id: d.id,
        phone: d.data().phone || d.id,
        ...d.data()
      }));
      const combinedMap = /* @__PURE__ */ new Map();
      archived.forEach((c) => combinedMap.set(c.phone || c.id, c));
      legacy.forEach((c) => {
        const key = c.phone || c.id;
        if (!combinedMap.has(key)) combinedMap.set(key, c);
      });
      return Array.from(combinedMap.values()).sort(
        (a, b) => (b.deletedAt || "").localeCompare(a.deletedAt || "")
      );
    } catch (err) {
      logger.warn("[FirestoreConversationRepo] Fallback to In-Memory for findTrash", { error: err.message });
      return inMemoryConvFallback.findTrash(tenantId);
    }
  }
  async softDelete(tenantId, phone, deletedBy) {
    await inMemoryConvFallback.softDelete(tenantId, phone, deletedBy);
    const chatRef = this.db.collection(`tenants/${tenantId}/chats`).doc(phone);
    const snap = await chatRef.get();
    if (!snap.exists) return false;
    await this.db.collection(`tenants/${tenantId}/deleted_chats`).doc(phone).set({
      ...snap.data(),
      phone,
      originalPhone: phone,
      status: "deleted",
      deletedAt: (/* @__PURE__ */ new Date()).toISOString(),
      deletedBy,
      _archivedFrom: `tenants/${tenantId}/chats/${phone}`
    });
    await chatRef.delete();
    logger.info(`[ConversationRepo] Hard-deleted chat ${phone} \u2014 archived to deleted_chats`);
    return true;
  }
  async restore(tenantId, phone) {
    await inMemoryConvFallback.restore(tenantId, phone);
    try {
      const deletedRef = this.db.collection(`tenants/${tenantId}/deleted_chats`).doc(phone);
      const snap = await deletedRef.get();
      if (snap.exists) {
        const data = snap.data();
        const chatRef = this.db.collection(`tenants/${tenantId}/chats`).doc(phone);
        await chatRef.set({
          ...data,
          status: "active",
          deletedAt: null,
          deletedBy: null
        });
        await deletedRef.delete();
        logger.info(`[ConversationRepo] Restored chat ${phone} from deleted_chats to active chats`);
        return true;
      }
      const docRef = this.db.collection(`tenants/${tenantId}/chats`).doc(phone);
      await docRef.set({
        status: "active",
        deletedAt: null,
        deletedBy: null
      }, { merge: true });
      return true;
    } catch (err) {
      logger.warn("[FirestoreConversationRepo] Firestore restore failed", { error: err.message });
      return false;
    }
  }
  async purgeExpiredTrash(tenantId, daysRetention = 30) {
    await inMemoryConvFallback.purgeExpiredTrash(tenantId, daysRetention);
    const cutoffIso = new Date(Date.now() - daysRetention * 24 * 60 * 60 * 1e3).toISOString();
    let purgedCount = 0;
    try {
      const batch = this.db.batch();
      const delSnap = await this.db.collection(`tenants/${tenantId}/deleted_chats`).get();
      delSnap.docs.forEach((doc) => {
        const deletedAt = doc.data()?.deletedAt;
        if (daysRetention === 0 || deletedAt && deletedAt < cutoffIso) {
          batch.delete(doc.ref);
          purgedCount++;
        }
      });
      let legacyQuery = this.db.collection(`tenants/${tenantId}/chats`).where("status", "==", "deleted");
      if (daysRetention > 0) {
        legacyQuery = legacyQuery.where("deletedAt", "<", cutoffIso);
      }
      const legSnap = await legacyQuery.get();
      legSnap.docs.forEach((doc) => {
        batch.delete(doc.ref);
        purgedCount++;
      });
      if (purgedCount > 0) {
        await batch.commit();
        logger.info(`[FirestoreConversationRepo] Purged ${purgedCount} chats (deleted_chats + legacy) with ${daysRetention} days retention filter`);
      }
    } catch (err) {
      logger.warn("[FirestoreConversationRepo] Firestore purgeExpiredTrash failed", { error: err.message });
    }
    return purgedCount;
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
    const calculatedQuoteStr = ctx.calculatedQuote ? JSON.stringify(ctx.calculatedQuote) : "No disponible a\xFAn (requiere monto de recibo)";
    const systemPrompt = `Eres Sof\xEDa, Asesora Comercial de O3 Energy M\xE9xico.
Tu personalidad es c\xE1lida, emp\xE1tica, profesional y altamente orientada a brindar una excelente experiencia de usuario (U-First).
Tu objetivo es guiar al cliente en un flujo comercial consultivo de 6 pasos en WhatsApp.

REGLA 0 \u2014 MODO USUARIO DE REGRESO (PRIORIDAD M\xC1XIMA):
Si <is_returning_context>true</is_returning_context>, analiza el mensaje del usuario sem\xE1nticamente:
- Si el usuario est\xE1 saludando o iniciando conversaci\xF3n (en cualquier forma coloquial, modismo, variaci\xF3n o idioma, ej. "hola", "buenas tardes", "qu\xE9 tal", "hey", "buenos d\xEDas", etc.):
  Tu \xDANICO objetivo es generar una bienvenida c\xE1lida, emp\xE1tica y natural que incluya:
  a) Saludo personalizado por su nombre (ej. "\xA1Hola H\xE9ctor! \u{1F60A} Qu\xE9 gusto saludarte de nuevo...")
  b) Resumen breve de 1-2 l\xEDneas de d\xF3nde quedaron (ap\xF3yate en <previous_session_summary>)
  c) Pregunta natural ofreciendo opciones claras:
     - Retomar la asesor\xEDa donde se quedaron
     - Conectarlo directamente con uno de nuestros asesores especializados
  Establece obligatoriamente "returning_user_greeted": true en tu respuesta JSON.
  PROHIBIDO: mostrar cotizaci\xF3n instant\xE1nea, pedir datos ya recopilados o usar men\xFAs numerados rob\xF3ticos.

- Si el usuario NO est\xE1 saludando y hace una pregunta concreta, aporta un dato nuevo o responde algo espec\xEDfico:
  Responde directamente a lo consultado sin ritual de bienvenida.
  Establece "returning_user_greeted": false en tu respuesta JSON.

EJEMPLO DE BIENVENIDA IDEAL:
"\xA1Hola H\xE9ctor! \u{1F60A} \xA1Qu\xE9 gusto verte de nuevo por aqu\xED! La \xFAltima vez est\xE1bamos revisando las opciones solares para tu hogar con tu recibo de luz. \xBFQuieres que retomemos justo donde lo dejamos, o prefieres que te comunique con uno de nuestros asesores comerciales para avanzar de inmediato? \u2600\uFE0F"

REGLAS ESENCIALES DE INTERACCI\xD3N Y CERO ALUCINACI\xD3N:

1. MANEJO GRACEFUL DEL NOMBRE (PASO 1):
   - Si el cliente menciona su nombre en el mensaje inicial (ej. "Hola soy Carlos y pago $2,800 de luz"), extr\xE1elo en "client_name": "Carlos" y sal\xFAdalo por su nombre de inmediato.
   - Si el cliente NO da su nombre (es decir, el nombre actual es "Cliente"), sal\xFAdalo c\xE1lidamente y solic\xEDtale su nombre de forma amable, pero NUNCA ignores los otros datos que ya te haya dado.

2. CERO ALUCINACI\xD3N DE PANELES Y N\xDAMEROS (FUENTE \xDANICA DE LA VERDAD):
   - NUNCA inventes o menciones una cantidad de paneles solares o montos si NO dispones de los valores calculados en <calculated_quote>.
   - Si <calculated_quote> contiene datos, utiliza EXCLUSIVAMENTE esa cifra de paneles (ej. si indica 4 paneles, menciona 4 paneles; si indica 6 paneles, menciona 6 paneles).
   - Si el usuario pregunta cu\xE1ntos paneles necesita ANTES de indicar su recibo, responde con elegancia: "Para darte el n\xFAmero exacto de paneles y el costo de tu inversi\xF3n, necesito conocer tu consumo mensual o bimestral en pesos de tu recibo CFE. \xBFCu\xE1nto pagas aproximadamente?" NUNCA inventes un n\xFAmero de paneles.

3. CONVERSI\xD3N Y DESGLOSE TRANSPARENTE DE RECI BOS CFE (BIMESTRAL VS. MENSUAL):
   - En M\xE9xico los recibos CFE son habitualmente BIMESTRALES.
   - Si el usuario menciona un monto (ej. $2,800) y no aclara frecuencia, o si dice "bimestral", extrae "bill_frequency": "bimestral".
   - Al responder, desglosa SIEMPRE de forma clara y transparente la equivalencia: "Tu recibo bimestral de $2,800 MXN equivale a $1,400 MXN al mes. Con este consumo, tu sistema ideal es de [N de <calculated_quote>] paneles solares...".

4. GATING DE CONSENTIMIENTO PARA COTIZACI\xD3N (PASO 4):
   - Al contar con el recibo y tipo de techo, no muestres la cotizaci\xF3n masiva directamente de golpe.
   - Haz una pregunta de abreboca ofreciendo la cotizaci\xF3n:
     "\xA1Excelente [Nombre]! Con un consumo de $[Monto], tu sistema ideal es de aproximadamente [N] paneles solares de alta eficiencia. \xBFTe gustar\xEDa que te presente la propuesta preliminar de inversi\xF3n y ahorro estimado?"
   - Si el cliente responde afirmativamente ("S\xED", "Adelante", "Por favor", "Mu\xE9stramela"), establece "quote_consent_given": true.

5. PROPUESTA PROACTIVA DE VISITA T\xC9CNICA GRATUITA EN SITIO:
   - Si el usuario no tiene la foto del recibo a la mano ("No la tengo a la mano") o al avanzar en la calificaci\xF3n del techo/sombras (Pasos 3 y 4), ofrece proactivamente una Visita T\xE9cnica Gratuita en Sitio por nuestros ingenieros certificados para evaluar la estructura, sombras y trayectoria el\xE9ctrica. Establece "propose_technical_visit": true. El bot PERMANECE ACTIVO (botDisabled = false).

6. CANALIZACI\xD3N CON ASESOR COMERCIAL ESPECIALIZADO:
   - Si el usuario solicita hablar con una persona, requiere asesor\xEDa personalizada avanzada o pide la llamada de un especialista, establece "trigger_human_handoff": true, "propose_advisor_handoff": true y "handoff_reason": "Solicitud de atenci\xF3n humana".

7. RESPUESTAS LIMPIAS Y NO REPETITIVAS:
   - Responde de forma directa a las preguntas espec\xEDficas del usuario sin volver a repetir la tarjeta larga de cotizaci\xF3n en cada turno.

8. ANUNCIO C\xC1LIDO DEL BROCHURE / INFOGRAF\xCDA (U-FIRST UX):
   - Cuando vayas a solicitar el env\xEDo del brochure o infograf\xEDa ("media_to_send": "INSTALACION_PROFESIONAL"), incluye SIEMPRE al final de tu mensaje de texto una frase amable anunci\xE1ndolo:
     "\xA1Mientras tanto, te comparto un brochure para que conozcas nuestros servicios e instalaci\xF3n profesional! \u{1F4C4}\u2600\uFE0F"

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
  "returning_user_greeted": boolean,
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
    <is_returning_context>${Boolean(ctx.isReturningContext)}</is_returning_context>
    <previous_session_summary>${ctx.previousSessionSummary ? this.sanitizeInput(ctx.previousSessionSummary) : "Sin sesi\xF3n previa"}</previous_session_summary>
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
        propose_technical_visit: Boolean(parsed.propose_technical_visit),
        propose_advisor_handoff: Boolean(parsed.propose_advisor_handoff),
        trigger_human_handoff: Boolean(parsed.trigger_human_handoff),
        handoff_reason: parsed.handoff_reason || void 0,
        returning_user_greeted: Boolean(parsed.returning_user_greeted),
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

// server/domain/services/BillNormalizerService.ts
var BillNormalizerService = class {
  /**
   * Normalizes bill amount and frequency.
   * If frequency is omitted, defaults to 'bimestral' (standard CFE residential billing in Mexico).
   */
  static normalize(input) {
    let amount = input.rawAmount;
    let frequency = this.parseFrequency(input.rawFrequency);
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
      frequency = "bimestral";
      isDefaultAssumed = true;
    }
    let monthlyBill;
    let bimestralBill;
    if (frequency === "bimestral") {
      bimestralBill = amount;
      monthlyBill = Math.round(amount / 2);
    } else {
      monthlyBill = amount;
      bimestralBill = Math.round(amount * 2);
    }
    const formattedSummary = frequency === "bimestral" ? `$${bimestralBill.toLocaleString("es-MX")} MXN bimestrales ($${monthlyBill.toLocaleString("es-MX")} MXN/mes)` : `$${monthlyBill.toLocaleString("es-MX")} MXN mensuales ($${bimestralBill.toLocaleString("es-MX")} MXN/bimestre)`;
    return {
      monthlyBill,
      bimestralBill,
      frequency,
      isDefaultFrequencyAssumed: isDefaultAssumed,
      formattedSummary
    };
  }
  /**
   * Pre-parses raw message text to extract numeric amounts and frequency keywords
   * before LLM invocation for single-pass prompt seeding.
   */
  static preParseUserText(text) {
    if (!text) return null;
    const lower = text.toLowerCase().trim();
    const cleanedText = lower.replace(/,/g, "");
    const amountMatch = cleanedText.match(/(?:pago|monto|recibo|es de|son|\$)?\s*(\d{3,6})\s*(?:pesos|mxn)?/);
    if (!amountMatch) return null;
    const amount = parseInt(amountMatch[1], 10);
    if (isNaN(amount) || amount <= 0) return null;
    let frequency;
    if (lower.includes("bimestre") || lower.includes("bimestral") || lower.includes("cada dos meses") || lower.includes("cada 2 meses") || lower.includes("bimensual")) {
      frequency = "bimestral";
    } else if (lower.includes("mes") || lower.includes("mensual") || lower.includes("al mes") || lower.includes("cada mes")) {
      frequency = "mensual";
    }
    return { amount, frequency };
  }
  static parseFrequency(rawFreq) {
    if (!rawFreq) return void 0;
    const lower = rawFreq.toLowerCase();
    if (lower.includes("bimest")) return "bimestral";
    if (lower.includes("mens")) return "mensual";
    return void 0;
  }
};

// server/infrastructure/services/AgentNotificationService.ts
import nodemailer from "nodemailer";
var AgentNotificationService = class {
  constructor(agentRepo) {
    this.agentRepo = agentRepo;
  }
  // ─── Agent Assignment (Round-Robin by assignedLeadsCount) ──────────────────
  async getAssignedAgent(tenantId) {
    const agents = await this.agentRepo.findActiveAgents(tenantId);
    if (agents.length > 0) {
      return agents[0];
    }
    logger.warn("[AgentNotification] No active agents found \u2014 using fallback agent config");
    return {
      id: "fallback",
      tenantId,
      name: "Equipo Comercial O3 Energy",
      email: AppConfig.agents.fallbackEmail,
      whatsappPhone: AppConfig.agents.fallbackWhatsapp,
      isActive: true,
      assignedLeadsCount: 0,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  // ─── Dual Notification Orchestrator ────────────────────────────────────────
  async notify(agent, prospect, tenantId) {
    const [emailResult, waResult] = await Promise.allSettled([
      this.notifyEmail(agent, prospect),
      this.notifyWhatsApp(agent, prospect)
    ]);
    if (emailResult.status === "fulfilled" && emailResult.value) {
      logger.info("[AgentNotification] Email sent successfully", { agent: agent.email });
    } else {
      logger.error("[AgentNotification] CRITICAL: Email notification failed", {
        agent: agent.email,
        error: emailResult.status === "rejected" ? emailResult.reason : "unknown"
      });
    }
    if (waResult.status === "fulfilled" && waResult.value) {
      logger.info("[AgentNotification] WhatsApp template sent successfully", { phone: agent.whatsappPhone });
    } else {
      logger.warn("[AgentNotification] WhatsApp notification failed \u2014 email fallback active", {
        phone: agent.whatsappPhone,
        error: waResult.status === "rejected" ? waResult.reason : "skipped"
      });
    }
    if (agent.id !== "fallback") {
      await this.agentRepo.incrementLeadCount(tenantId, agent.id).catch(
        (err) => logger.warn("[AgentNotification] Failed to increment lead count", { error: err.message })
      );
    }
  }
  // ─── Email Premium ─────────────────────────────────────────────────────────
  async notifyEmail(agent, prospect) {
    const { server, port, user, pass } = AppConfig.smtp;
    if (!pass) {
      logger.info("[AgentNotification Email SIM]", { agent: agent.email, prospect: prospect.nombre });
      return true;
    }
    const portalUrl = AppConfig.appUrl;
    const subject = `\u{1F525} URGE CONTACTAR \u2014 ${prospect.nombre} (+${prospect.phone})`;
    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:system-ui,-apple-system,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px;">
    <div style="background:linear-gradient(135deg,#f59e0b,#d97706);border-radius:16px 16px 0 0;padding:32px;text-align:center;">
      <h1 style="margin:0;color:#0f172a;font-size:22px;font-weight:800;">\u{1F525} PROSPECTO CALIFICADO</h1>
      <p style="margin:8px 0 0;color:#451a03;font-size:14px;opacity:0.9;">O3 Energy M\xE9xico \u2014 Sof\xEDa IA Comercial</p>
    </div>
    <div style="background:#1e293b;border-radius:0 0 16px 16px;padding:32px;">
      <div style="background:#0f172a;border-radius:12px;padding:24px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:10px 0;color:#94a3b8;font-size:13px;font-weight:600;">\u{1F464} NOMBRE</td><td style="padding:10px 0;color:#f1f5f9;font-size:14px;font-weight:700;">${prospect.nombre}</td></tr>
          <tr><td style="padding:10px 0;color:#94a3b8;font-size:13px;font-weight:600;">\u{1F4F1} WHATSAPP</td><td style="padding:10px 0;"><a href="https://wa.me/${prospect.phone}" style="color:#f59e0b;font-weight:700;text-decoration:none;">+${prospect.phone}</a></td></tr>
          <tr><td style="padding:10px 0;color:#94a3b8;font-size:13px;font-weight:600;">\u{1F4B0} RECIBO CFE</td><td style="padding:10px 0;color:#f59e0b;font-size:15px;font-weight:800;">${prospect.montoRecibo}</td></tr>
          <tr><td style="padding:10px 0;color:#94a3b8;font-size:13px;font-weight:600;">\u26A1 SISTEMA EST.</td><td style="padding:10px 0;color:#f1f5f9;font-size:14px;">${prospect.sistemaEstimado}</td></tr>
          ${prospect.location ? `<tr><td style="padding:10px 0;color:#94a3b8;font-size:13px;font-weight:600;">\u{1F4CD} UBICACI\xD3N</td><td style="padding:10px 0;color:#f1f5f9;font-size:14px;">${prospect.location}</td></tr>` : ""}
          ${prospect.handoffReason ? `<tr><td style="padding:10px 0;color:#94a3b8;font-size:13px;font-weight:600;">\u{1F4AC} MOTIVO</td><td style="padding:10px 0;color:#f1f5f9;font-size:14px;">${prospect.handoffReason}</td></tr>` : ""}
        </table>
      </div>
      <div style="text-align:center;">
        <a href="${portalUrl}" style="display:inline-block;background:linear-gradient(135deg,#f59e0b,#d97706);color:#0f172a;font-weight:800;font-size:15px;padding:14px 32px;border-radius:12px;text-decoration:none;">\u2600\uFE0F Abrir Portal y Responder</a>
      </div>
      <p style="margin:24px 0 0;text-align:center;color:#475569;font-size:12px;">Agente: ${agent.name} \u2014 ${agent.email}</p>
    </div>
  </div>
</body>
</html>`;
    try {
      const transporter = nodemailer.createTransport({
        host: server,
        port,
        secure: port === 465,
        auth: { user, pass }
      });
      await transporter.sendMail({ from: `"Sof\xEDa IA - O3 Energy" <${user}>`, to: agent.email, subject, html });
      return true;
    } catch (err) {
      logger.error("[AgentNotification] Email send failed", { error: err.message });
      throw err;
    }
  }
  // ─── WhatsApp HSM Template (Meta-compliant) ────────────────────────────────
  async notifyWhatsApp(agent, prospect) {
    const { accessToken, phoneNumberId, waAgentTemplateName } = AppConfig.meta;
    if (!accessToken || !phoneNumberId) {
      logger.info("[AgentNotification WA SIM] Would send WA template to agent", { phone: agent.whatsappPhone });
      return true;
    }
    if (!agent.whatsappPhone) {
      logger.warn("[AgentNotification] Agent has no WhatsApp phone configured \u2014 skipping WA");
      return false;
    }
    try {
      const payload = {
        messaging_product: "whatsapp",
        to: agent.whatsappPhone,
        type: "template",
        template: {
          name: waAgentTemplateName,
          // Configurable via env var — zero hardcoding
          language: { code: "es_MX" },
          components: [{
            type: "body",
            parameters: [
              { type: "text", text: prospect.nombre.substring(0, 60) },
              // {{1}}
              { type: "text", text: prospect.phone },
              // {{2}}
              { type: "text", text: prospect.montoRecibo },
              // {{3}}
              { type: "text", text: prospect.sistemaEstimado.substring(0, 60) }
              // {{4}}
            ]
          }]
        }
      };
      const res = await fetch(
        `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
        { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) }
      );
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(`Meta API ${res.status}: ${JSON.stringify(errData)}`);
      }
      return true;
    } catch (err) {
      logger.warn("[AgentNotification] WhatsApp template failed \u2014 email fallback active", {
        agent: agent.email,
        error: err.message
      });
      return false;
    }
  }
};

// server/infrastructure/persistence/AgentRepository.ts
var inMemoryAgentsStore = {};
var AgentRepository = class {
  constructor(db2) {
    this.db = db2;
  }
  col(tenantId) {
    if (this.db) {
      return this.db.collection(`tenants/${tenantId}/config/agents`);
    }
    return null;
  }
  getTenantStore(tenantId) {
    if (!inMemoryAgentsStore[tenantId]) {
      inMemoryAgentsStore[tenantId] = {};
    }
    return inMemoryAgentsStore[tenantId];
  }
  async findAll(tenantId) {
    const colRef = this.col(tenantId);
    if (colRef) {
      try {
        const snap = await colRef.orderBy("createdAt", "asc").get();
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      } catch (err) {
        logger.warn("[AgentRepo] Fallback to In-Memory for findAll", { error: err.message });
      }
    }
    const store = this.getTenantStore(tenantId);
    return Object.values(store).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async findById(tenantId, agentId) {
    const colRef = this.col(tenantId);
    if (colRef) {
      try {
        const doc = await colRef.doc(agentId).get();
        if (!doc.exists) return null;
        return { id: doc.id, ...doc.data() };
      } catch (err) {
        logger.warn("[AgentRepo] Fallback to In-Memory for findById", { error: err.message });
      }
    }
    const store = this.getTenantStore(tenantId);
    return store[agentId] || null;
  }
  async findActiveAgents(tenantId) {
    const colRef = this.col(tenantId);
    if (colRef) {
      try {
        const snap = await colRef.where("isActive", "==", true).orderBy("assignedLeadsCount", "asc").get();
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      } catch (err) {
        logger.warn("[AgentRepo] Fallback to In-Memory for findActiveAgents", { error: err.message });
      }
    }
    const store = this.getTenantStore(tenantId);
    return Object.values(store).filter((a) => a.isActive).sort((a, b) => a.assignedLeadsCount - b.assignedLeadsCount);
  }
  async save(agent, tenantId) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const store = this.getTenantStore(tenantId);
    if (agent.id) {
      const colRef2 = this.col(tenantId);
      if (colRef2) {
        try {
          const ref = colRef2.doc(agent.id);
          await ref.set({ ...agent, updatedAt: now }, { merge: true });
        } catch (err) {
          logger.warn("[AgentRepo] Fallback to In-Memory for save update", { error: err.message });
        }
      }
      const existing = store[agent.id] || {};
      const updated = {
        ...existing,
        ...agent,
        id: agent.id,
        tenantId,
        updatedAt: now
      };
      store[agent.id] = updated;
      return updated;
    }
    const colRef = this.col(tenantId);
    const newId = colRef ? colRef.doc().id : `agent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const newAgent = {
      ...agent,
      id: newId,
      tenantId,
      assignedLeadsCount: agent.assignedLeadsCount ?? 0,
      isActive: agent.isActive ?? true,
      createdAt: now,
      updatedAt: now
    };
    if (colRef) {
      try {
        await colRef.doc(newId).set(newAgent);
      } catch (err) {
        logger.warn("[AgentRepo] Fallback to In-Memory for save create", { error: err.message });
      }
    }
    store[newId] = newAgent;
    return newAgent;
  }
  async deactivate(tenantId, agentId) {
    const colRef = this.col(tenantId);
    if (colRef) {
      try {
        const ref = colRef.doc(agentId);
        const doc = await ref.get();
        if (doc.exists) {
          await ref.update({ isActive: false, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
        }
      } catch (err) {
        logger.warn("[AgentRepo] Fallback to In-Memory for deactivate", { error: err.message });
      }
    }
    const store = this.getTenantStore(tenantId);
    if (store[agentId]) {
      store[agentId].isActive = false;
      store[agentId].updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      return true;
    }
    return false;
  }
  async incrementLeadCount(tenantId, agentId) {
    const colRef = this.col(tenantId);
    if (colRef) {
      try {
        const ref = colRef.doc(agentId);
        const snap = await ref.get();
        if (snap.exists) {
          const current = snap.data()?.assignedLeadsCount || 0;
          await ref.update({
            assignedLeadsCount: current + 1,
            updatedAt: (/* @__PURE__ */ new Date()).toISOString()
          });
        }
      } catch (err) {
        logger.warn("[AgentRepo] Fallback to In-Memory for incrementLeadCount", { error: err.message });
      }
    }
    const store = this.getTenantStore(tenantId);
    if (store[agentId]) {
      store[agentId].assignedLeadsCount = (store[agentId].assignedLeadsCount || 0) + 1;
      store[agentId].updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    }
  }
  async delete(tenantId, agentId) {
    const colRef = this.col(tenantId);
    let firestoreDeleted = false;
    if (colRef) {
      try {
        const ref = colRef.doc(agentId);
        const doc = await ref.get();
        if (doc.exists) {
          await ref.delete();
          firestoreDeleted = true;
        }
      } catch (err) {
        logger.warn("[AgentRepo] Fallback to In-Memory for delete", { error: err.message });
      }
    }
    const store = this.getTenantStore(tenantId);
    if (store[agentId]) {
      delete store[agentId];
      return true;
    }
    return firestoreDeleted;
  }
};

// server/application/orchestration/SofiaFlowOrchestrator.ts
var SofiaFlowOrchestrator = class {
  constructor(conversationRepo, leadRepo, quoteEngine2, llmProvider2, sendWhatsAppText, emailService2, db2) {
    this.conversationRepo = conversationRepo;
    this.leadRepo = leadRepo;
    this.quoteEngine = quoteEngine2;
    this.llmProvider = llmProvider2;
    this.sendWhatsAppText = sendWhatsAppText;
    this.emailService = emailService2;
    this.db = db2;
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
    const isReturningContext = conv.messages.length >= 2 && conv.nombre !== "Cliente" && conv.state.phase !== "GREETING" && conv.state.phase !== "HUMAN_HANDOFF" && !conv.state.returningUserAcknowledged;
    let previousSessionSummary;
    if (isReturningContext) {
      const bill = conv.state.monthlyBill ? `$${conv.state.monthlyBill} MXN/mes` : null;
      const phase = conv.state.phase;
      const parts = [
        bill ? `recibo de ${bill}` : null,
        phase === "QUOTATION" || phase === "FINANCING" ? "se present\xF3 cotizaci\xF3n preliminar" : null,
        phase === "TECHNICAL_SURVEY" ? "se evaluaba el sistema t\xE9cnico" : null
      ].filter(Boolean);
      previousSessionSummary = parts.length > 0 ? `Conversaci\xF3n previa: ${parts.join(", ")}.` : "El cliente ha interactuado previamente con Sof\xEDa.";
    }
    const currentStepInt = this.phaseToStepInt(conv.state.phase);
    const preParsedBill = BillNormalizerService.normalize({
      rawAmount: conv.state.monthlyBill ? conv.state.billFrequency === "bimestral" ? conv.state.bimestralBill || conv.state.monthlyBill * 2 : conv.state.monthlyBill : null,
      rawFrequency: conv.state.billFrequency,
      messageText
    });
    if (preParsedBill) {
      conv.state.monthlyBill = preParsedBill.monthlyBill;
      conv.state.bimestralBill = preParsedBill.bimestralBill;
      conv.state.billFrequency = preParsedBill.frequency;
      conv.montoRecibo = preParsedBill.formattedSummary;
    }
    let calculatedQuoteInfo = null;
    let preCalcResult = null;
    if (conv.state.monthlyBill) {
      preCalcResult = this.quoteEngine.calculate(conv.state.monthlyBill, conv.state.extraLoads);
      calculatedQuoteInfo = {
        panels: preCalcResult.panels,
        systemPowerKw: preCalcResult.systemPowerKw,
        estimatedCost: preCalcResult.estimatedCost,
        monthlySavings: preCalcResult.monthlySavings,
        annualSavings: preCalcResult.annualSavings,
        rangeLabel: preCalcResult.systemDescription
      };
    }
    const promptCtx = {
      phone,
      userName: conv.nombre,
      currentStep: currentStepInt,
      extractedData: {
        billAmount: conv.state.monthlyBill,
        billFrequency: conv.state.billFrequency,
        roofType: conv.state.roofType,
        meterDistance: conv.state.meterDistance,
        extraLoads: conv.state.extraLoads,
        location: conv.state.location,
        ownership: conv.state.isOwner ? "Propio" : void 0
      },
      calculatedQuote: calculatedQuoteInfo,
      quoteConsentRequested: conv.state.quoteConsentRequested,
      quoteConsentGiven: conv.state.quoteConsentGiven,
      botDisabled: conv.botDisabled,
      latestUserMessage: messageText,
      historySummary: conv.messages.slice(-6).map((m) => `${m.sender}: ${m.text}`).join("\n"),
      isReturningContext,
      previousSessionSummary
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
    if (parsed.returning_user_greeted) {
      conv.state.returningUserAcknowledged = true;
    }
    const mediaSent = [];
    let finalReply = parsed.message_to_user;
    if (parsed.extracted_data) {
      if (parsed.extracted_data.client_name && conv.nombre === "Cliente") {
        conv.nombre = parsed.extracted_data.client_name;
      }
      if (parsed.extracted_data.bill_amount) {
        const normalized = BillNormalizerService.normalize({
          rawAmount: parsed.extracted_data.bill_amount,
          rawFrequency: parsed.extracted_data.bill_frequency,
          messageText
        });
        if (normalized) {
          const billChanged = conv.state.monthlyBill !== normalized.monthlyBill;
          conv.state.monthlyBill = normalized.monthlyBill;
          conv.state.bimestralBill = normalized.bimestralBill;
          conv.state.billFrequency = normalized.frequency;
          conv.montoRecibo = normalized.formattedSummary;
          if (billChanged && conv.state.completedSteps.includes("QUOTE_SENT")) {
            conv.state.completedSteps = conv.state.completedSteps.filter((step) => step !== "QUOTE_SENT");
          }
        }
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
    if (parsed.propose_technical_visit) {
      conv.state.technicalVisitProposed = true;
    }
    const isQuoteNotYetSent = !conv.state.completedSteps.includes("QUOTE_SENT");
    if (conv.state.quoteConsentGiven && isQuoteNotYetSent && conv.state.monthlyBill) {
      const bill = conv.state.monthlyBill;
      const calcResult = this.quoteEngine.calculate(bill, conv.state.extraLoads);
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
    let isHandoff = parsed.trigger_human_handoff || parsed.propose_advisor_handoff;
    if (messageText.toLowerCase().includes("asesor") || messageText.toLowerCase().includes("humano") || messageText.toLowerCase().includes("agente")) {
      isHandoff = true;
    }
    if (isHandoff) {
      conv.botDisabled = true;
      conv.state.phase = "HUMAN_HANDOFF";
      conv.state.advisorHandoffProposed = true;
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
      const agentRepo = new AgentRepository(this.db);
      const notificationService = new AgentNotificationService(agentRepo);
      const agent = await notificationService.getAssignedAgent(conv.tenantId);
      const prospect = {
        nombre: name,
        phone,
        montoRecibo: `$${conv.state.monthlyBill || 0} MXN/mes`,
        sistemaEstimado: conv.state.roofType || "Sistema Residencial",
        location: conv.state.location,
        handoffReason: reason,
        conversationSummary: conv.messages.slice(-4).map((m) => `${m.sender}: ${m.text}`).join("\n")
      };
      await notificationService.notify(agent, prospect, conv.tenantId);
      logger.info(`[SofiaFlowOrchestrator] Lead handoff completed for ${phone} (Assigned Agent: ${agent.name})`);
    } catch (err) {
      logger.error(`[SofiaFlowOrchestrator] Lead handoff failed:`, err);
      try {
        await this.emailService.sendLeadNotification({
          leadName: name,
          phone,
          monthlyBill: conv.state.monthlyBill || 0,
          notes: `Solicitud de atenci\xF3n humana en WhatsApp: ${reason}`
        });
      } catch (emailErr) {
        logger.error(`[SofiaFlowOrchestrator] Fallback email notification also failed:`, emailErr);
      }
    }
  }
};

// server/infrastructure/web/container.ts
import { getApps as getApps2 } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import nodemailer2 from "nodemailer";
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
      const transporter = nodemailer2.createTransport({
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
var _db = null;
var _convRepo;
var _leadRepo;
var _agentRepo;
function initRepositories(db2) {
  _db = db2;
  if (db2) {
    logger.info("[DI] initRepositories: Using Firestore repositories (multi-tenant)");
    _convRepo = new FirestoreConversationRepository(db2);
    _leadRepo = new FirestoreLeadRepository(db2);
    _agentRepo = new AgentRepository(db2);
  } else {
    logger.warn("[DI] initRepositories: Firestore not available \u2014 using InMemory repositories");
    _convRepo = new InMemoryConversationRepository();
    _leadRepo = new InMemoryLeadRepository();
    _agentRepo = new AgentRepository(null);
  }
}
function getAgentRepo() {
  if (!_agentRepo) {
    _agentRepo = new AgentRepository(_db || null);
  }
  return _agentRepo;
}
function buildReceiveMessageUseCase() {
  const repos = _convRepo && _leadRepo ? { convRepo: _convRepo, leadRepo: _leadRepo } : getRepos();
  const flowOrchestrator = new SofiaFlowOrchestrator(
    repos.convRepo,
    repos.leadRepo,
    quoteEngine,
    llmProvider,
    sendWhatsAppMessage,
    emailService,
    _db
  );
  return new ReceiveMessageUseCase(
    repos.convRepo,
    flowOrchestrator,
    sendWhatsAppMessage,
    sendWhatsAppMedia
  );
}

// server/infrastructure/services/AuthService.ts
import crypto from "crypto";
var AuthService = class {
  /**
   * Verifies a plain text password against a scrypt-hashed password (salt:derivedHex).
   * Uses crypto.timingSafeEqual to prevent timing side-channel attacks.
   */
  static verifyPassword(password, storedHash) {
    if (!password || !storedHash || !storedHash.includes(":")) {
      return false;
    }
    try {
      const [salt, keyHex] = storedHash.split(":");
      if (!salt || !keyHex) return false;
      const derivedKey = crypto.scryptSync(password, salt, 64);
      const targetKey = Buffer.from(keyHex, "hex");
      if (derivedKey.length !== targetKey.length) {
        return false;
      }
      return crypto.timingSafeEqual(derivedKey, targetKey);
    } catch (err) {
      console.error("[AuthService] Error verifying password hash:", err);
      return false;
    }
  }
  /**
   * Signs a JWT with HS256 using AppConfig.auth.jwtSecret.
   */
  static generateToken(user) {
    const secret = AppConfig.auth.jwtSecret;
    const now = Math.floor(Date.now() / 1e3);
    const expiresInSeconds = (AppConfig.auth.tokenExpiresInHours || 8) * 3600;
    const header = { alg: "HS256", typ: "JWT" };
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      iat: now,
      exp: now + expiresInSeconds
    };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signatureInput = `${headerB64}.${payloadB64}`;
    const signatureB64 = crypto.createHmac("sha256", secret).update(signatureInput).digest("base64url");
    return `${signatureInput}.${signatureB64}`;
  }
  /**
   * Verifies a JWT token signature and expiration.
   */
  static verifyToken(token) {
    if (!token || typeof token !== "string") {
      return { valid: false, error: "Token missing" };
    }
    const parts = token.trim().split(".");
    if (parts.length !== 3) {
      return { valid: false, error: "Malformed token structure" };
    }
    const [headerB64, payloadB64, signatureB64] = parts;
    const secret = AppConfig.auth.jwtSecret;
    const expectedSignatureB64 = crypto.createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest("base64url");
    const sigBuf = Buffer.from(signatureB64);
    const expectedBuf = Buffer.from(expectedSignatureB64);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { valid: false, error: "Invalid token signature" };
    }
    try {
      const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf-8");
      const payload = JSON.parse(payloadJson);
      const now = Math.floor(Date.now() / 1e3);
      if (payload.exp && payload.exp < now) {
        return { valid: false, error: "Token has expired" };
      }
      return { valid: true, payload };
    } catch (err) {
      return { valid: false, error: "Failed to parse token payload" };
    }
  }
  /**
   * Parses standard HTTP Cookie header into a key-value record.
   */
  static parseCookies(cookieHeader) {
    const list = {};
    if (!cookieHeader) return list;
    cookieHeader.split(";").forEach((cookie) => {
      const parts = cookie.split("=");
      if (parts.length >= 2) {
        const name = parts[0].trim();
        const val = parts.slice(1).join("=").trim();
        list[name] = decodeURIComponent(val);
      }
    });
    return list;
  }
  /**
   * Generates a Set-Cookie header string for the httpOnly token.
   */
  static createHttpOnlyCookie(token, maxAgeSeconds = 8 * 3600) {
    const isProd = process.env.NODE_ENV === "production";
    const secureFlag = isProd ? "; Secure" : "";
    return `token=${token}; HttpOnly${secureFlag}; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
  }
  /**
   * Generates a Set-Cookie header string to clear/expire the cookie.
   */
  static createLogoutCookie() {
    const isProd = process.env.NODE_ENV === "production";
    const secureFlag = isProd ? "; Secure" : "";
    return `token=; HttpOnly${secureFlag}; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
};

// server/infrastructure/services/GoogleAuthService.ts
function decodeBase64Url(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const padded2 = pad ? padded + "=".repeat(4 - pad) : padded;
  return Buffer.from(padded2, "base64").toString("utf-8");
}
function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    return null;
  }
}
var GoogleAuthService = class {
  /**
   * Verifies a Firebase Google ID Token by checking:
   * 1. JWT structure and payload decode
   * 2. Token expiration (exp claim)
   * 3. Audience matches Firebase project ID
   * 4. Email is present
   *
   * For a demo environment — skips cryptographic signature verification.
   * For production, enable signature verification via Firebase public keys.
   */
  static async verifyGoogleToken(idToken) {
    if (!idToken || typeof idToken !== "string") return null;
    try {
      const payload = decodeJwtPayload(idToken);
      if (!payload) {
        logger.warn("[GoogleAuthService] Failed to decode JWT payload");
        return null;
      }
      const now = Math.floor(Date.now() / 1e3);
      if (payload.exp && payload.exp < now) {
        logger.warn("[GoogleAuthService] Token has expired");
        return null;
      }
      const projectId = process.env.FIREBASE_PROJECT_ID || "agente-comercial-solar";
      if (payload.aud && payload.aud !== projectId) {
        logger.warn("[GoogleAuthService] Token audience mismatch", {
          expected: projectId,
          received: payload.aud
        });
        return null;
      }
      if (!payload.email) {
        logger.warn("[GoogleAuthService] Token has no email claim");
        return null;
      }
      if (payload.iss && !payload.iss.includes("securetoken.google.com")) {
        logger.warn("[GoogleAuthService] Token issuer invalid", { iss: payload.iss });
        return null;
      }
      return {
        uid: payload.sub || payload.user_id || payload.email,
        email: payload.email,
        name: payload.name || payload.email.split("@")[0],
        picture: payload.picture
      };
    } catch (err) {
      logger.warn("[GoogleAuthService] Token verification failed:", err.message);
      return null;
    }
  }
};

// server/infrastructure/services/RateLimiterService.ts
import { getApps as getApps3 } from "firebase-admin/app";
import { getFirestore as getFirestore2 } from "firebase-admin/firestore";
var memoryLimiter = /* @__PURE__ */ new Map();
var RateLimiterService = class {
  static {
    this.MAX_ATTEMPTS = 5;
  }
  static {
    this.WINDOW_MS = 15 * 60 * 1e3;
  }
  // 15 minutes window
  /**
   * Checks if an IP is currently rate limited.
   * Returns { allowed: boolean, remainingAttempts: number, resetInSeconds: number }
   */
  static async checkRateLimit(ip) {
    const now = Date.now();
    try {
      if (getApps3().length > 0) {
        const db2 = getFirestore2();
        const docId = Buffer.from(ip).toString("hex");
        const docRef = db2.collection("rate_limits").doc(docId);
        const snap = await docRef.get();
        if (snap.exists) {
          const data = snap.data();
          if (now - data.firstAttemptAt > this.WINDOW_MS) {
            return { allowed: true, remainingAttempts: this.MAX_ATTEMPTS, resetInSeconds: 0 };
          }
          if (data.attempts >= this.MAX_ATTEMPTS) {
            const resetInSeconds = Math.ceil((data.firstAttemptAt + this.WINDOW_MS - now) / 1e3);
            return { allowed: false, remainingAttempts: 0, resetInSeconds: Math.max(1, resetInSeconds) };
          }
          return { allowed: true, remainingAttempts: this.MAX_ATTEMPTS - data.attempts, resetInSeconds: 0 };
        }
      }
    } catch (err) {
      logger.warn("[RateLimiterService] Firestore read failed, falling back to memory", { error: err.message });
    }
    const record = memoryLimiter.get(ip);
    if (!record) {
      return { allowed: true, remainingAttempts: this.MAX_ATTEMPTS, resetInSeconds: 0 };
    }
    if (now - record.firstAttemptAt > this.WINDOW_MS) {
      memoryLimiter.delete(ip);
      return { allowed: true, remainingAttempts: this.MAX_ATTEMPTS, resetInSeconds: 0 };
    }
    if (record.attempts >= this.MAX_ATTEMPTS) {
      const resetInSeconds = Math.ceil((record.firstAttemptAt + this.WINDOW_MS - now) / 1e3);
      return { allowed: false, remainingAttempts: 0, resetInSeconds: Math.max(1, resetInSeconds) };
    }
    return { allowed: true, remainingAttempts: this.MAX_ATTEMPTS - record.attempts, resetInSeconds: 0 };
  }
  /**
   * Registers a failed attempt for an IP address.
   */
  static async registerFailedAttempt(ip) {
    const now = Date.now();
    let record = memoryLimiter.get(ip);
    if (!record || now - record.firstAttemptAt > this.WINDOW_MS) {
      record = { ip, attempts: 1, firstAttemptAt: now, blockedUntil: 0 };
    } else {
      record.attempts += 1;
    }
    memoryLimiter.set(ip, record);
    if (getApps3().length > 0) {
      try {
        const db2 = getFirestore2();
        const docId = Buffer.from(ip).toString("hex");
        const docRef = db2.collection("rate_limits").doc(docId);
        docRef.set(record, { merge: true }).catch((err) => {
          logger.warn("[RateLimiterService] Async Firestore write failed", { error: err.message });
        });
      } catch (err) {
        logger.warn("[RateLimiterService] Firestore exception on write", { error: err.message });
      }
    }
  }
  /**
   * Clears attempts on successful login.
   */
  static async resetRateLimit(ip) {
    memoryLimiter.delete(ip);
    if (getApps3().length > 0) {
      try {
        const db2 = getFirestore2();
        const docId = Buffer.from(ip).toString("hex");
        const docRef = db2.collection("rate_limits").doc(docId);
        docRef.delete().catch(() => {
        });
      } catch (e) {
      }
    }
  }
  /**
   * Utility for testing: clears all memory limits.
   */
  static clearMemoryStore() {
    memoryLimiter.clear();
  }
};

// server/infrastructure/services/AuditLogService.ts
import { getApps as getApps4 } from "firebase-admin/app";
import { getFirestore as getFirestore3 } from "firebase-admin/firestore";
var memoryAuditLogs = [];
var AuditLogService = class {
  /**
   * Appends an immutable audit log entry to Firestore with in-memory fallback.
   */
  static async logEvent(entry) {
    const fullEntry = {
      ...entry,
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    memoryAuditLogs.push(fullEntry);
    logger.info(`[AuditLog] EVENT REGISTERED: ${fullEntry.eventType}`, {
      user: fullEntry.userEmail,
      resource: fullEntry.resourceId,
      ip: fullEntry.ipAddress
    });
    if (getApps4().length > 0) {
      try {
        const db2 = getFirestore3();
        db2.collection(`tenants/${fullEntry.tenantId}/audit_logs`).doc(fullEntry.id).set(fullEntry).catch((err) => {
          logger.warn("[AuditLog] Non-blocking Firestore save failed", { error: err.message });
        });
      } catch (err) {
        logger.warn("[AuditLog] Firestore write exception", { error: err.message });
      }
    }
    return fullEntry;
  }
  /**
   * Retrieves paginated audit logs for a tenant.
   */
  static async getLogs(tenantId, page = 1, limit = 50, eventType) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    if (getApps4().length > 0) {
      try {
        const db2 = getFirestore3();
        let query = db2.collection(`tenants/${tenantId}/audit_logs`);
        if (eventType) {
          query = query.where("eventType", "==", eventType);
        }
        const snap = await query.orderBy("timestamp", "desc").get();
        if (!snap.empty) {
          const allDocs = snap.docs.map((d) => d.data());
          const total2 = allDocs.length;
          const totalPages2 = Math.ceil(total2 / safeLimit) || 1;
          const startIndex2 = (safePage - 1) * safeLimit;
          const paginatedData2 = allDocs.slice(startIndex2, startIndex2 + safeLimit);
          return {
            data: paginatedData2,
            total: total2,
            page: safePage,
            limit: safeLimit,
            totalPages: totalPages2
          };
        }
      } catch (err) {
        logger.warn("[AuditLog] Firestore fetch failed, returning in-memory logs", { error: err.message });
      }
    }
    let filtered = memoryAuditLogs.filter((l) => l.tenantId === tenantId);
    if (eventType) {
      filtered = filtered.filter((l) => l.eventType === eventType);
    }
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const total = filtered.length;
    const totalPages = Math.ceil(total / safeLimit) || 1;
    const startIndex = (safePage - 1) * safeLimit;
    const paginatedData = filtered.slice(startIndex, startIndex + safeLimit);
    return {
      data: paginatedData,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages
    };
  }
  /**
   * Utility for test suite cleanup
   */
  static clearMemoryLogs() {
    memoryAuditLogs.length = 0;
  }
};

// server/shared/utils/ipUtils.ts
function getClientIp(req) {
  const xForwardedFor = req.headers["x-forwarded-for"];
  if (xForwardedFor) {
    const rawIp = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
    const clientIp = rawIp.split(",")[0].trim();
    if (clientIp) return clientIp;
  }
  const realIp = req.headers["x-real-ip"];
  if (realIp) {
    const rawReal = Array.isArray(realIp) ? realIp[0] : realIp;
    if (rawReal.trim()) return rawReal.trim();
  }
  return req.socket.remoteAddress || "127.0.0.1";
}

// server/infrastructure/web/v2Router.ts
var v2Router = Router();
async function authRateLimiter(req, res, next) {
  const ip = getClientIp(req);
  const check = await RateLimiterService.checkRateLimit(ip);
  if (!check.allowed) {
    logger.warn("[AuthRateLimiter] IP blocked due to excessive failed attempts", { ip, resetInSeconds: check.resetInSeconds });
    return res.status(429).json({
      error: `Demasiados intentos fallidos de inicio de sesi\xF3n. Por favor espere ${check.resetInSeconds} segundos antes de reintentar.`,
      resetInSeconds: check.resetInSeconds
    });
  }
  next();
}
function requireAuth(req, res, next) {
  let token;
  const cookies = AuthService.parseCookies(req.headers.cookie);
  if (cookies.token) {
    token = cookies.token;
  }
  if (!token && req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7).trim();
    } else {
      token = authHeader.trim();
    }
  }
  if (!token) {
    return res.status(401).json({ error: "No autenticado. Cookie o Token de autorizaci\xF3n faltante." });
  }
  const verification = AuthService.verifyToken(token);
  if (!verification.valid || !verification.payload) {
    return res.status(401).json({ error: "Sesi\xF3n inv\xE1lida o expirada.", details: verification.error });
  }
  req.user = verification.payload;
  next();
}
function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Usuario no autenticado." });
    }
    if (!allowedRoles.includes(req.user.role)) {
      logger.warn("[RBAC] Forbidden access attempt", { user: req.user.email, role: req.user.role, required: allowedRoles });
      return res.status(403).json({ error: "Acceso denegado. Se requieren permisos elevados." });
    }
    next();
  };
}
v2Router.post("/auth/login", authRateLimiter, async (req, res) => {
  const ip = getClientIp(req);
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Correo y contrase\xF1a son requeridos." });
  }
  const configuredAdminEmail = AppConfig.auth.adminEmail.toLowerCase().trim();
  const inputEmail = String(email).toLowerCase().trim();
  if (inputEmail !== configuredAdminEmail) {
    await RateLimiterService.registerFailedAttempt(ip);
    return res.status(401).json({ error: "Credenciales inv\xE1lidas." });
  }
  const isValidPassword = AuthService.verifyPassword(password, AppConfig.auth.adminPasswordHash);
  if (!isValidPassword) {
    await RateLimiterService.registerFailedAttempt(ip);
    return res.status(401).json({ error: "Credenciales inv\xE1lidas." });
  }
  await RateLimiterService.resetRateLimit(ip);
  const user = { id: "admin-1", email: configuredAdminEmail, role: "admin" };
  const token = AuthService.generateToken(user);
  const cookieHeader = AuthService.createHttpOnlyCookie(token);
  res.setHeader("Set-Cookie", cookieHeader);
  logger.info("[Auth] Successful login for admin", { email: configuredAdminEmail, ip });
  return res.json({
    success: true,
    message: "Inicio de sesi\xF3n exitoso",
    user,
    token
    // Optional for external API clients
  });
});
v2Router.post("/auth/google", authRateLimiter, async (req, res) => {
  const ip = getClientIp(req);
  const { idToken } = req.body || {};
  if (!idToken || typeof idToken !== "string") {
    return res.status(400).json({ error: "Se requiere un ID Token de Google v\xE1lido." });
  }
  const googleUser = await GoogleAuthService.verifyGoogleToken(idToken);
  if (!googleUser) {
    await RateLimiterService.registerFailedAttempt(ip);
    return res.status(401).json({ error: "Token de Google inv\xE1lido o expirado." });
  }
  await RateLimiterService.resetRateLimit(ip);
  const user = {
    id: googleUser.uid,
    email: googleUser.email,
    role: "admin"
    // Demo mode: any Google user gets admin role
  };
  const token = AuthService.generateToken(user);
  const cookieHeader = AuthService.createHttpOnlyCookie(token);
  res.setHeader("Set-Cookie", cookieHeader);
  logger.info("[Auth] Successful Google OAuth login", { email: googleUser.email, ip });
  return res.json({
    success: true,
    message: "Inicio de sesi\xF3n con Google exitoso",
    user
  });
});
v2Router.get("/auth/me", requireAuth, (req, res) => {
  return res.json({
    authenticated: true,
    user: req.user
  });
});
v2Router.post("/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", AuthService.createLogoutCookie());
  return res.json({ success: true, message: "Sesi\xF3n cerrada correctamente" });
});
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
v2Router.get("/chats", requireAuth, async (req, res) => {
  const tenantId = req.query.tenantId || AppConfig.tenant.defaultId;
  try {
    const chats = await _convRepo.findAll(tenantId);
    return res.json(chats);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
v2Router.get("/chats/trash", requireAuth, requireRole(["admin", "agent"]), async (req, res) => {
  const tenantId = req.query.tenantId || AppConfig.tenant.defaultId;
  try {
    const trashedChats = await _convRepo.findTrash(tenantId);
    return res.json(trashedChats);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
v2Router.delete("/chats/:phone", requireAuth, requireRole(["admin"]), async (req, res) => {
  const { phone } = req.params;
  const tenantId = req.query.tenantId || req.body?.tenantId || AppConfig.tenant.defaultId;
  const ip = getClientIp(req);
  try {
    const success = await _convRepo.softDelete(tenantId, phone, req.user.email);
    if (!success) {
      return res.status(404).json({ error: "Chat no encontrado para archivar" });
    }
    await AuditLogService.logEvent({
      eventType: "CHAT_SOFT_DELETED",
      userEmail: req.user.email,
      userRole: req.user.role,
      resourceId: phone,
      tenantId,
      ipAddress: ip,
      details: { action: "Soft Delete chat", phone }
    });
    return res.json({ success: true, message: "Chat archivado en la Papelera de Reciclaje correctamente." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
v2Router.post("/chats/:phone/restore", requireAuth, requireRole(["admin"]), async (req, res) => {
  const { phone } = req.params;
  const tenantId = req.query.tenantId || req.body?.tenantId || AppConfig.tenant.defaultId;
  const ip = getClientIp(req);
  try {
    const success = await _convRepo.restore(tenantId, phone);
    if (!success) {
      return res.status(404).json({ error: "Chat no encontrado para restaurar" });
    }
    await AuditLogService.logEvent({
      eventType: "CHAT_RESTORED",
      userEmail: req.user.email,
      userRole: req.user.role,
      resourceId: phone,
      tenantId,
      ipAddress: ip,
      details: { action: "Restaurar chat", phone }
    });
    return res.json({ success: true, message: "Chat restaurado a la lista activa correctamente." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
v2Router.post("/chats/purge-expired", requireAuth, requireRole(["admin"]), async (req, res) => {
  const tenantId = req.query.tenantId || req.body?.tenantId || AppConfig.tenant.defaultId;
  const retentionDays = parseInt(req.query.retentionDays || req.body?.retentionDays || "30", 10);
  const ip = getClientIp(req);
  try {
    const purgedCount = await _convRepo.purgeExpiredTrash(tenantId, retentionDays);
    if (purgedCount > 0) {
      await AuditLogService.logEvent({
        eventType: "TRASH_PURGED",
        userEmail: req.user.email,
        userRole: req.user.role,
        resourceId: `purged_${purgedCount}_items`,
        tenantId,
        ipAddress: ip,
        details: { action: "Purge Expired Trash", purgedCount, retentionDays }
      });
    }
    return res.json({
      success: true,
      message: `Se han purgado permanentemente ${purgedCount} conversaciones archivadas con m\xE1s de ${retentionDays} d\xEDas en la papelera.`,
      purgedCount
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
v2Router.get("/audit-logs", requireAuth, requireRole(["admin"]), async (req, res) => {
  const tenantId = req.query.tenantId || AppConfig.tenant.defaultId;
  const page = parseInt(req.query.page || "1", 10);
  const limit = parseInt(req.query.limit || "50", 10);
  const eventType = req.query.eventType;
  try {
    const paginatedLogs = await AuditLogService.getLogs(tenantId, page, limit, eventType);
    return res.json(paginatedLogs);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
v2Router.post("/chats/:phone/toggle-bot", requireAuth, async (req, res) => {
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
v2Router.post("/chats/:phone/message", requireAuth, async (req, res) => {
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
v2Router.post("/copilot/query", requireAuth, async (req, res) => {
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
v2Router.get("/leads", requireAuth, async (req, res) => {
  const tenantId = req.query.tenantId || AppConfig.tenant.defaultId;
  try {
    const leads = await _leadRepo.findAll(tenantId);
    return res.json(leads);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
v2Router.post("/leads/:id/contacted", requireAuth, async (req, res) => {
  const { id } = req.params;
  const tenantId = req.body.tenantId || AppConfig.tenant.defaultId;
  try {
    await _leadRepo.updateStatus(tenantId, id, "contacted");
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
v2Router.post("/leads/:id/notes", requireAuth, async (req, res) => {
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
v2Router.post("/reset-demo", requireAuth, async (req, res) => {
  return res.json({ success: true });
});
v2Router.get("/agents", requireAuth, async (req, res) => {
  try {
    const tenantId = req.query.tenantId || AppConfig.tenant.defaultId;
    const agentRepo = getAgentRepo();
    const agents = await agentRepo.findAll(tenantId);
    const masked = agents.map((a) => ({
      ...a,
      whatsappPhone: a.whatsappPhone ? a.whatsappPhone.length > 4 ? a.whatsappPhone.slice(0, -4).replace(/./g, "*") + a.whatsappPhone.slice(-4) : a.whatsappPhone : ""
    }));
    return res.json({ agents: masked });
  } catch (err) {
    logger.error("[v2Router] Error in GET /agents", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});
v2Router.post("/agents", requireAuth, requireRole(["admin"]), async (req, res) => {
  try {
    const { name, email, whatsappPhone } = req.body || {};
    if (!name || !email) {
      return res.status(400).json({ error: "name y email son obligatorios" });
    }
    const tenantId = req.body.tenantId || AppConfig.tenant.defaultId;
    const agentRepo = getAgentRepo();
    const agent = await agentRepo.save({
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      whatsappPhone: String(whatsappPhone || "").trim().replace(/\D/g, ""),
      tenantId,
      isActive: true,
      assignedLeadsCount: 0
    }, tenantId);
    await AuditLogService.logEvent({
      eventType: "AGENT_CREATED",
      userEmail: req.user.email,
      userRole: req.user.role,
      resourceId: agent.id,
      tenantId,
      ipAddress: getClientIp(req),
      details: { agentName: agent.name, agentEmail: agent.email }
    }).catch((e) => logger.warn("[v2Router] Audit log failed for AGENT_CREATED", { error: e.message }));
    return res.status(201).json({ success: true, agent });
  } catch (err) {
    logger.error("[v2Router] Error in POST /agents", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});
v2Router.put("/agents/:agentId", requireAuth, requireRole(["admin"]), async (req, res) => {
  try {
    const { agentId } = req.params;
    const { name, email, whatsappPhone, isActive } = req.body || {};
    const tenantId = req.body.tenantId || AppConfig.tenant.defaultId;
    const agentRepo = getAgentRepo();
    const existing = await agentRepo.findById(tenantId, agentId);
    if (!existing) return res.status(404).json({ error: "Agente no encontrado" });
    const updated = await agentRepo.save({
      ...existing,
      name: name ? String(name).trim() : existing.name,
      email: email ? String(email).trim().toLowerCase() : existing.email,
      whatsappPhone: whatsappPhone !== void 0 && whatsappPhone !== "" ? String(whatsappPhone).trim().replace(/\D/g, "") : existing.whatsappPhone,
      isActive: isActive !== void 0 ? Boolean(isActive) : existing.isActive
    }, tenantId);
    await AuditLogService.logEvent({
      eventType: "AGENT_UPDATED",
      userEmail: req.user.email,
      userRole: req.user.role,
      resourceId: agentId,
      tenantId,
      ipAddress: getClientIp(req),
      details: { agentName: updated.name, isActive: updated.isActive }
    }).catch((e) => logger.warn("[v2Router] Audit log failed for AGENT_UPDATED", { error: e.message }));
    return res.json({ success: true, agent: updated });
  } catch (err) {
    logger.error("[v2Router] Error in PUT /agents/:agentId", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});
v2Router.delete("/agents/:agentId", requireAuth, requireRole(["admin"]), async (req, res) => {
  try {
    const { agentId } = req.params;
    const tenantId = req.query.tenantId || req.body.tenantId || AppConfig.tenant.defaultId;
    const agentRepo = getAgentRepo();
    const deleted = await agentRepo.delete(tenantId, agentId);
    if (!deleted) return res.status(404).json({ error: "Agente no encontrado" });
    await AuditLogService.logEvent({
      eventType: "AGENT_DELETED",
      userEmail: req.user.email,
      userRole: req.user.role,
      resourceId: agentId,
      tenantId,
      ipAddress: getClientIp(req),
      details: { agentId }
    }).catch((e) => logger.warn("[v2Router] Audit log failed for AGENT_DELETED", { error: e.message }));
    return res.json({ success: true });
  } catch (err) {
    logger.error("[v2Router] Error in DELETE /agents/:agentId", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
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
  if (getApps5().length > 0) {
    const dbId = firebaseConfig.firestoreDatabaseId;
    db = dbId && dbId !== "(default)" ? getFirestore4(dbId) : getFirestore4();
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
    db = dbId && dbId !== "(default)" ? getFirestore4(dbId) : getFirestore4();
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

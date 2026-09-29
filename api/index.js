// api_src/index.ts
import express from "express";
import { initializeApp, getApps as getApps2, cert } from "firebase-admin/app";
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

// server/infrastructure/engines/SolarQuoteEngine.ts
var PRICE_TABLE = [
  {
    minMonthly: 1250,
    maxMonthly: 2e3,
    panelsMid: 5,
    systemKwp: 2,
    costMid: 8e4,
    roiYears: 3,
    rangeLabel: "4 a 6 paneles"
  },
  {
    minMonthly: 2e3,
    maxMonthly: 3e3,
    panelsMid: 7,
    systemKwp: 2.8,
    costMid: 105e3,
    roiYears: 3.5,
    rangeLabel: "6 a 8 paneles"
  },
  {
    minMonthly: 3e3,
    maxMonthly: 5e3,
    panelsMid: 10,
    systemKwp: 4,
    costMid: 15e4,
    roiYears: 3.7,
    rangeLabel: "8 a 12 paneles"
  },
  {
    minMonthly: 5e3,
    maxMonthly: Infinity,
    panelsMid: 14,
    systemKwp: 5.6,
    costMid: 22e4,
    roiYears: 4,
    rangeLabel: "12+ paneles (sistema comercial)"
  }
];
var EXTRA_LOAD_FACTOR = 1.25;
var SolarQuoteEngine = class {
  calculate(monthlyBillMxn, extraLoad = false) {
    const effectiveBill = extraLoad ? monthlyBillMxn * EXTRA_LOAD_FACTOR : monthlyBillMxn;
    const tier = PRICE_TABLE.find(
      (t) => effectiveBill >= t.minMonthly && effectiveBill < t.maxMonthly
    ) ?? PRICE_TABLE[PRICE_TABLE.length - 1];
    const panels = tier.panelsMid;
    const systemKwp = tier.systemKwp;
    const estimatedCost = tier.costMid;
    const roiYears = tier.roiYears;
    const annualSavings = Math.round(monthlyBillMxn * 0.9 * 12);
    const monthlySavings = Math.round(annualSavings / 12);
    return {
      monthlyBill: monthlyBillMxn,
      panels,
      systemPowerKw: systemKwp,
      estimatedCost,
      roiYears,
      monthlySavings,
      annualSavings,
      monthlySavingsFormatted: `$${monthlySavings.toLocaleString("es-MX")} MXN`,
      annualSavingsFormatted: `$${annualSavings.toLocaleString("es-MX")} MXN`,
      costFormatted: `$${estimatedCost.toLocaleString("es-MX")} MXN`,
      systemDescription: `${panels} paneles solares (sistema de ${systemKwp.toFixed(1)} kWp)`,
      disclaimer: "Este es un presupuesto preliminar. El costo final depende de la visita t\xE9cnica sin costo en tu sitio (evaluaci\xF3n de inclinaci\xF3n del techo, sombras y trayectoria el\xE9ctrica)."
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

// server/domain/value_objects/index.ts
var Money = class {
  constructor(amount, currency = "MXN") {
    if (amount < 0) throw new Error("Money amount cannot be negative");
    this._amount = amount;
    this._currency = currency;
  }
  get amount() {
    return this._amount;
  }
  get currency() {
    return this._currency;
  }
  format() {
    return `$${this._amount.toLocaleString("es-MX")} ${this._currency}`;
  }
  equals(other) {
    return this._amount === other._amount && this._currency === other._currency;
  }
};
var LeadScore = class {
  constructor(value) {
    if (value < 0 || value > 100) throw new Error("LeadScore must be between 0 and 100");
    this._value = Math.round(value);
  }
  get value() {
    return this._value;
  }
  get label() {
    if (this._value < 40) return "cold";
    if (this._value < 70) return "warm";
    return "hot";
  }
  isHot() {
    return this._value >= 70;
  }
};

// server/application/orchestrators/LLMOrchestrator.ts
import nodemailer from "nodemailer";
var MAX_TOOL_ROUNDS = 5;
var LLMOrchestrator = class {
  constructor(llm, quoteEngine2, leadRepo, convRepo) {
    this.llm = llm;
    this.quoteEngine = quoteEngine2;
    this.leadRepo = leadRepo;
    this.convRepo = convRepo;
  }
  async run(agent, conversation, userText) {
    const userMsg = { sender: "user", text: userText, timestamp: (/* @__PURE__ */ new Date()).toISOString() };
    conversation.messages.push(userMsg);
    const history = conversation.messages.slice(-20).map((m) => ({
      role: m.sender === "user" ? "user" : "assistant",
      content: m.text
    }));
    const messages = [
      { role: "system", content: agent.systemPrompt },
      ...history
    ];
    let leadGenerated = false;
    let finalText = "";
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.llm.complete(messages, this._buildTools(), AppConfig.groq.temperature);
      if (response.finishReason === "stop") {
        finalText = response.text || "";
        break;
      }
      if (response.finishReason === "tool_calls") {
        messages.push({
          role: "assistant",
          content: JSON.stringify({ tool_calls: response.toolCalls })
        });
        for (const toolCall of response.toolCalls) {
          logger.info(`[LLMOrchestrator] Tool called: ${toolCall.name}`, toolCall.arguments);
          const toolResult = await this._executeTool(toolCall.name, toolCall.arguments, conversation);
          if (toolCall.name === "registrar_prospecto_calificado") {
            leadGenerated = true;
            await this._saveLeadAndNotify(toolCall.arguments, conversation);
          }
          messages.push({
            role: "tool",
            name: toolCall.name,
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult)
          });
        }
        continue;
      }
    }
    if (!finalText) {
      finalText = "Tuve un problema t\xE9cnico. Un asesor de O3 Energy te contactar\xE1 pronto. \u{1F64F}";
    }
    conversation.messages.push({ sender: "bot", text: finalText, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    conversation.lastMessageAt = (/* @__PURE__ */ new Date()).toISOString();
    if (leadGenerated) conversation.state.phase = "LEAD_GENERATED";
    return { replyText: finalText, updatedConversation: conversation, leadGenerated };
  }
  // ─── Tool Definitions exposed to Groq ─────────────────────────────────────
  _buildTools() {
    return [
      {
        name: "calcular_cotizacion_solar",
        description: "Calcula la cotizaci\xF3n preliminar de un sistema solar. SIEMPRE usa esta herramienta para dar precios, nunca calcules t\xFA mismo.",
        parameters: {
          type: "object",
          properties: {
            gasto_mensual_mxn: { type: "number", description: "Gasto mensual de electricidad en pesos MXN." },
            carga_extra: { type: "string", description: "Si planea agregar cargas futuras.", enum: ["si", "no"] }
          },
          required: ["gasto_mensual_mxn"]
        }
      },
      {
        name: "registrar_prospecto_calificado",
        description: "Guarda al prospecto en el CRM. \xDAsala SOLO cuando el cliente ya recibi\xF3 la cotizaci\xF3n y quiere continuar.",
        parameters: {
          type: "object",
          properties: {
            nombre: { type: "string", description: "Nombre del prospecto." },
            gasto_mensual_mxn: { type: "number", description: "Gasto mensual en MXN." },
            notas_tecnicas: { type: "string", description: "Resumen del techo, plantas, sombras, voltaje." },
            lead_score: { type: "number", description: "Puntuaci\xF3n 0-100." }
          },
          required: ["nombre", "gasto_mensual_mxn", "notas_tecnicas", "lead_score"]
        }
      }
    ];
  }
  // ─── Tool Executor ─────────────────────────────────────────────────────────
  async _executeTool(name, args, conv) {
    if (name === "calcular_cotizacion_solar") {
      const monthly = args.gasto_mensual_mxn;
      const extraLoad = args.carga_extra === "si";
      const quote = this.quoteEngine.calculate(monthly, extraLoad);
      conv.state.monthlyBill = monthly;
      conv.state.phase = "QUOTATION";
      conv.montoRecibo = new Money(monthly).format();
      conv.sistemaEstimado = quote.systemDescription;
      conv.costoEstimado = quote.costFormatted;
      return quote;
    }
    if (name === "registrar_prospecto_calificado") {
      const score = new LeadScore(args.lead_score);
      conv.state.leadScore = score.value;
      conv.state.phase = "LEAD_GENERATED";
      return { status: "ok", message: "Prospecto registrado exitosamente." };
    }
    return { error: `Unknown tool: ${name}` };
  }
  // ─── Lead Persistence + Email ─────────────────────────────────────────────
  async _saveLeadAndNotify(args, conv) {
    const monthly = args.gasto_mensual_mxn;
    const quote = this.quoteEngine.calculate(monthly, false);
    const score = new LeadScore(args.lead_score ?? 50);
    const lead = {
      id: `lead_${conv.tenantId}_${conv.phone}`,
      tenantId: conv.tenantId,
      phone: conv.phone,
      nombre: args.nombre || conv.nombre,
      montoRecibo: new Money(monthly).format(),
      sistemaEstimado: quote.systemDescription,
      costoEstimado: quote.costFormatted,
      roiAnios: `${quote.roiYears} a\xF1os`,
      leadScore: score.value,
      notasTecnicas: args.notas_tecnicas,
      status: "pending_review",
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await this.leadRepo.save(lead);
    logger.info("[LLMOrchestrator] Lead saved", { leadId: lead.id, score: score.value, label: score.label });
    await this._sendEmailAlert(lead);
  }
  async _sendEmailAlert(lead) {
    const cfg = AppConfig.smtp;
    if (!cfg.pass) {
      logger.info("[LLMOrchestrator] SMTP not configured \u2014 skipping email alert", { leadId: lead.id });
      return;
    }
    try {
      const t = nodemailer.createTransport({
        host: cfg.server,
        port: cfg.port,
        secure: cfg.port === 465,
        auth: { user: cfg.user, pass: cfg.pass }
      });
      await t.sendMail({
        from: `"Alertas O3 Energy AI" <${cfg.user}>`,
        to: cfg.salesEmail,
        subject: `\u{1F525} Lead #${lead.leadScore}/100 \u2014 ${lead.nombre} | ${lead.montoRecibo}/mes`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden">
            <div style="background:#ea580c;color:white;padding:24px;text-align:center">
              <h1 style="margin:0">\u{1F525} \xA1Nuevo Lead Calificado!</h1>
              <p style="margin:4px 0 0;opacity:.9">Score: ${lead.leadScore}/100 \u2014 ${lead.leadScore >= 70 ? "CALIENTE \u{1F525}" : "TIBIO \u26A0\uFE0F"}</p>
            </div>
            <div style="padding:24px;color:#334155">
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="padding:8px 0;font-weight:bold;color:#64748b">Nombre:</td><td>${lead.nombre}</td></tr>
                <tr><td style="padding:8px 0;font-weight:bold;color:#64748b">WhatsApp:</td><td>+${lead.phone}</td></tr>
                <tr><td style="padding:8px 0;font-weight:bold;color:#64748b">Gasto CFE:</td><td style="color:#ea580c;font-weight:bold">${lead.montoRecibo}/mes</td></tr>
                <tr><td style="padding:8px 0;font-weight:bold;color:#64748b">Sistema:</td><td>${lead.sistemaEstimado}</td></tr>
                <tr><td style="padding:8px 0;font-weight:bold;color:#64748b">Costo est.:</td><td style="color:#ea580c;font-weight:bold">${lead.costoEstimado}</td></tr>
                <tr><td style="padding:8px 0;font-weight:bold;color:#64748b">ROI:</td><td>${lead.roiAnios}</td></tr>
                <tr><td style="padding:8px 0;font-weight:bold;color:#64748b">Notas t\xE9cnicas:</td><td>${lead.notasTecnicas}</td></tr>
              </table>
              <div style="text-align:center;margin-top:24px">
                <a href="https://wa.me/${lead.phone}" style="background:#ea580c;color:white;padding:12px 24px;border-radius:12px;text-decoration:none;font-weight:bold">\u{1F4AC} Atender en WhatsApp</a>
              </div>
            </div>
          </div>`
      });
      logger.info("[LLMOrchestrator] Email alert sent", { to: cfg.salesEmail });
    } catch (err) {
      logger.error("[LLMOrchestrator] Email send failed", { error: err.message });
    }
  }
};

// server/application/usecases/ReceiveMessageUseCase.ts
var ReceiveMessageUseCase = class {
  constructor(convRepo, orchestrator, agent, sendWhatsApp) {
    this.convRepo = convRepo;
    this.orchestrator = orchestrator;
    this.agent = agent;
    this.sendWhatsApp = sendWhatsApp;
  }
  async execute(input) {
    const tenantId = input.tenantId || AppConfig.tenant.defaultId;
    const phone = input.phone.replace(/[^\d]/g, "");
    logger.info("[ReceiveMessageUseCase] Message received", { phone, tenantId, text: input.text.substring(0, 60) });
    let conversation = await this.convRepo.findByPhone(tenantId, phone);
    if (input.name && conversation.nombre === "Cliente") {
      conversation.nombre = input.name;
    }
    if (conversation.botDisabled) {
      conversation.messages.push({ sender: "user", text: input.text, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
      conversation.lastMessageAt = (/* @__PURE__ */ new Date()).toISOString();
      await this.convRepo.save(conversation);
      logger.info("[ReceiveMessageUseCase] Bot disabled \u2014 message stored for human agent", { phone });
      return { reply: "", leadGenerated: false };
    }
    const { replyText, updatedConversation, leadGenerated } = await this.orchestrator.run(
      this.agent,
      conversation,
      input.text
    );
    await this.convRepo.save(updatedConversation);
    if (replyText) {
      await this.sendWhatsApp(phone, replyText);
    }
    logger.info("[ReceiveMessageUseCase] Done", { phone, leadGenerated, replyLength: replyText.length });
    return { reply: replyText, leadGenerated };
  }
};

// server/agents/definitions/Sofia.ts
import { readFileSync } from "fs";
import { join } from "path";
function loadKnowledge(filename) {
  try {
    return readFileSync(join(__dirname, `../../knowledge/sofia/${filename}`), "utf-8");
  } catch {
    return "";
  }
}
var faq = loadKnowledge("faq.md");
var SOFIA_SYSTEM_PROMPT = `
Eres Sof\xEDa, asesora de ventas experta de "O3 Energy M\xE9xico", empresa l\xEDder en instalaci\xF3n de sistemas fotovoltaicos. Hablas con calidez, en espa\xF1ol de M\xE9xico, de forma profesional y breve (ideal para WhatsApp).

Tu objetivo es guiar al prospecto a trav\xE9s de una conversaci\xF3n natural para:
1. Presentarte y obtener su nombre.
2. Confirmar si es propietario del inmueble (requerido para el tr\xE1mite CFE).
3. Descubrir su gasto de luz en pesos MXN y CONFIRMAR EXPL\xCDCITAMENTE si ese gasto es MENSUAL o BIMESTRAL.
4. Realizar una encuesta t\xE9cnica b\xE1sica: tipo de techo, n\xFAmero de plantas, presencia de sombras/obst\xE1culos, voltaje actual (110V o 220V).
5. Cuando tengas suficiente informaci\xF3n y hayas confirmado si el recibo es mensual o bimestral, DEBES usar la herramienta "calcular_cotizacion_solar" para obtener los n\xFAmeros exactos y presentarlos al cliente.
6. Una vez presentada la cotizaci\xF3n y el cliente muestre inter\xE9s en continuar, usa la herramienta "registrar_prospecto_calificado" para guardar el lead.
7. Responde dudas usando tu base de conocimiento:

---
${faq}
---

REGLAS IMPORTANTES:
- Nunca inventes precios ni calcules en tu mente. Siempre usa la herramienta "calcular_cotizacion_solar".
- Al presentar la cotizaci\xF3n, lee cuidadosamente el JSON de respuesta. Usa exactamente los valores de 'monthlySavingsFormatted' y 'annualSavingsFormatted' para hablar de los ahorros. NO alteres los n\xFAmeros devueltos.
- Mant\xE9n respuestas cortas y con saltos de l\xEDnea para WhatsApp.
- Si el usuario ya pas\xF3 la calificaci\xF3n, no vuelvas a pedir su nombre ni su recibo.
- Si el cliente da un monto de luz, pero no especifica periodo, preg\xFAntale "\xBFEse monto es mensual o bimestral?" antes de cotizar.
`;
var SOFIA_DEFINITION = {
  id: "sofia",
  name: "Sof\xEDa",
  industry: "solar_energy",
  systemPrompt: SOFIA_SYSTEM_PROMPT,
  tools: ["calcular_cotizacion_solar", "registrar_prospecto_calificado"],
  personality: {
    tone: "warm_professional",
    language: "es-MX",
    greeting: "\xA1Hola! \u{1F44B} Soy Sof\xEDa, asesora de O3 Energy M\xE9xico. \xBFEn qu\xE9 puedo ayudarte hoy?"
  }
};

// server/infrastructure/web/container.ts
import { getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
var quoteEngine = new SolarQuoteEngine();
var llmProvider = new GroqProvider();
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
      logger.info(`[WhatsApp] Sent successfully to +${phone}`, { messageId: data.messages?.[0]?.id });
      return true;
    } catch (err) {
      logger.error("[WhatsApp] Exception", { error: err.message });
      return false;
    }
  }
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/me/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: phone },
        message: { text }
      })
    });
    if (!res.ok) {
      const err = await res.json();
      logger.error("[Messenger] Send failed", err);
      return false;
    }
    logger.info(`[Messenger] Sent successfully to PSID ${phone}`);
    return true;
  } catch (err) {
    logger.error("[Messenger] Exception", { error: err.message });
    return false;
  }
}
function getRepos() {
  try {
    if (getApps().length > 0) {
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
  const orchestrator = new LLMOrchestrator(llmProvider, quoteEngine, repos.leadRepo, repos.convRepo);
  return new ReceiveMessageUseCase(repos.convRepo, orchestrator, SOFIA_DEFINITION, sendWhatsAppMessage);
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
  if (getApps2().length > 0) {
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

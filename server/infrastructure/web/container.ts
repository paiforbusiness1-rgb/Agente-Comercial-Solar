/**
 * Dependency Injection Container — wires all components together.
 * If Firebase credentials are present → uses Firestore repos.
 * Otherwise → falls back to InMemory repos.
 */
import { GroqProvider } from '../llm/GroqProvider.js';
import { SolarQuoteEngine } from '../engines/SolarQuoteEngine.js';
import {
  FirestoreConversationRepository,
  FirestoreLeadRepository,
  InMemoryConversationRepository,
  InMemoryLeadRepository,
} from '../persistence/Repositories.js';
import { ReceiveMessageUseCase } from '../../application/usecases/ReceiveMessageUseCase.js';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { AppConfig } from '../../shared/config/AppConfig.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';
import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import nodemailer from 'nodemailer';

// ─── Infrastructure ────────────────────────────────────────────────────────
const quoteEngine = new SolarQuoteEngine();
const llmProvider = new GroqProvider();

// Email notification service
const emailService = {
  async sendLeadNotification(leadData: { leadName: string; phone: string; monthlyBill: number; notes?: string }) {
    const { server, port, user, pass, salesEmail } = AppConfig.smtp;
    if (!pass) {
      logger.info('[Email SIM] → Sales Team Lead Notification:', leadData);
      return true;
    }
    try {
      const transporter = nodemailer.createTransport({
        host: server,
        port,
        secure: port === 465,
        auth: { user, pass },
      });

      await transporter.sendMail({
        from: `"Sofía IA - O3 Energy" <${user}>`,
        to: salesEmail,
        subject: `🔥 NUEVO LEAD CALIFICADO SOLAR: ${leadData.leadName} (+${leadData.phone})`,
        text: `Se ha derivado un nuevo prospecto calificado desde WhatsApp:\n\nCliente: ${leadData.leadName}\nTeléfono: +${leadData.phone}\nRecibo CFE Estimado: $${leadData.monthlyBill} MXN\nNotas: ${leadData.notes || 'Ninguna'}\n\nFavor de atender este chat de inmediato.`,
      });
      logger.info(`[EmailService] Notification sent for lead +${leadData.phone}`);
      return true;
    } catch (err: any) {
      logger.error('[EmailService] Failed to send email:', err);
      return false;
    }
  },
};

// ─── WhatsApp / Meta sender (stateless utility) ───────────────────────────
async function sendWhatsAppMessage(phone: string, text: string): Promise<boolean> {
  const { accessToken, phoneNumberId } = AppConfig.meta;
  if (!accessToken) {
    logger.info(`[WhatsApp SIM] → +${phone}: ${text.substring(0, 80)}...`);
    return true;
  }

  if (phoneNumberId) {
    try {
      const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone,
          type: 'text',
          text: { preview_url: false, body: text },
        }),
      });
      const data = (await res.json()) as any;
      if (!res.ok) {
        logger.error('[WhatsApp] Send failed', data);
        return false;
      }
      logger.info(`[WhatsApp] Sent text successfully to +${phone}`, { messageId: data.messages?.[0]?.id });
      return true;
    } catch (err: any) {
      logger.error('[WhatsApp] Exception', { error: err.message });
      return false;
    }
  }

  return false;
}

async function sendWhatsAppMedia(phone: string, mediaUrl: string, caption?: string): Promise<boolean> {
  const { accessToken, phoneNumberId } = AppConfig.meta;
  if (!accessToken) {
    logger.info(`[WhatsApp SIM Media] → +${phone}: Link=${mediaUrl}`);
    return true;
  }

  if (phoneNumberId) {
    try {
      const isPdf = mediaUrl.endsWith('.pdf');
      const payload: any = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: isPdf ? 'document' : 'image',
      };

      if (isPdf) {
        payload.document = { link: mediaUrl, caption: caption || 'Cotización Solar O3 Energy' };
      } else {
        payload.image = { link: mediaUrl, caption: caption || '' };
      }

      const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as any;
      if (!res.ok) {
        logger.error('[WhatsApp Media] Send failed', data);
        return false;
      }
      logger.info(`[WhatsApp Media] Sent successfully to +${phone}`, { mediaUrl });
      return true;
    } catch (err: any) {
      logger.error('[WhatsApp Media] Exception', { error: err.message });
      return false;
    }
  }

  return false;
}

import { IConversationRepository } from '../../domain/repositories/IConversationRepository.js';
import { ILeadRepository } from '../../domain/repositories/ILeadRepository.js';
import { AgentRepository } from '../persistence/AgentRepository.js';

// ─── Repository selection (lazy — evaluated per-request) ─────────────────
function getRepos() {
  try {
    // Si no está inicializado pero existe FIREBASE_SERVICE_ACCOUNT_JSON en entorno
    if (getApps().length === 0 && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      try {
        const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        initializeApp({
          credential: cert(sa),
          projectId: sa.project_id || 'agente-comercial-solar',
        });
        logger.info('[DI] Initialized Firebase Admin from FIREBASE_SERVICE_ACCOUNT_JSON in container');
      } catch (saErr: any) {
        logger.warn('[DI] Error parsing FIREBASE_SERVICE_ACCOUNT_JSON in container', { error: saErr.message });
      }
    }

    if (getApps().length > 0) {
      const db = getFirestore();
      logger.info('[DI] Using Firestore repositories (multi-tenant)');
      return {
        convRepo: new FirestoreConversationRepository(db),
        leadRepo: new FirestoreLeadRepository(db),
      };
    }
  } catch (e: any) {
    logger.warn('[DI] Could not get Firestore, falling back to InMemory', { error: e.message });
  }
  logger.warn('[DI] Firestore not available — using InMemory repositories');
  return {
    convRepo: new InMemoryConversationRepository(),
    leadRepo: new InMemoryLeadRepository(),
  };
}

let _db: any = null;
let _convRepo: IConversationRepository | undefined;
let _leadRepo: ILeadRepository | undefined;
let _agentRepo: AgentRepository | undefined;

export function initRepositories(db: any | null) {
  _db = db;
  if (db) {
    logger.info('[DI] initRepositories: Using Firestore repositories (multi-tenant)');
    _convRepo = new FirestoreConversationRepository(db);
    _leadRepo = new FirestoreLeadRepository(db);
    _agentRepo = new AgentRepository(db);
  } else {
    logger.warn('[DI] initRepositories: Firestore not available — using InMemory repositories');
    _convRepo = new InMemoryConversationRepository();
    _leadRepo = new InMemoryLeadRepository();
    _agentRepo = new AgentRepository(null);
  }
}

export function getConvRepo(): IConversationRepository {
  if (!_convRepo) {
    const repos = getRepos();
    _convRepo = repos.convRepo;
    if (!_leadRepo) {
      _leadRepo = repos.leadRepo;
    }
  }
  return _convRepo;
}

export function getLeadRepo(): ILeadRepository {
  if (!_leadRepo) {
    const repos = getRepos();
    _leadRepo = repos.leadRepo;
    if (!_convRepo) {
      _convRepo = repos.convRepo;
    }
  }
  return _leadRepo;
}

export function getAgentRepo(): AgentRepository {
  if (!_agentRepo) {
    _agentRepo = new AgentRepository(_db || null);
  }
  return _agentRepo;
}

// ─── Proxies Defensivos (Anti-Crash / Zero-Undefined) ─────────────────────
export const convRepo: IConversationRepository = new Proxy({} as IConversationRepository, {
  get(_target, prop) {
    const instance = getConvRepo();
    const value = (instance as any)[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});

export const leadRepo: ILeadRepository = new Proxy({} as ILeadRepository, {
  get(_target, prop) {
    const instance = getLeadRepo();
    const value = (instance as any)[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});

export const agentRepo: AgentRepository = new Proxy({} as AgentRepository, {
  get(_target, prop) {
    const instance = getAgentRepo();
    const value = (instance as any)[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});

// ─── Use Case Factory ─────────────────────────────────────────────────────
export function buildReceiveMessageUseCase(): ReceiveMessageUseCase {
  const currentConvRepo = getConvRepo();
  const currentLeadRepo = getLeadRepo();

  const flowOrchestrator = new SofiaFlowOrchestrator(
    currentConvRepo,
    currentLeadRepo,
    quoteEngine,
    llmProvider,
    sendWhatsAppMessage as any,
    emailService,
    _db
  );

  return new ReceiveMessageUseCase(
    currentConvRepo,
    flowOrchestrator,
    sendWhatsAppMessage,
    sendWhatsAppMedia
  );
}

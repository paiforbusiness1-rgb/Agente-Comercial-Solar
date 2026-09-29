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
} from '../persistence/Repositories';
import { LLMOrchestrator } from '../../application/orchestrators/LLMOrchestrator.js';
import { ReceiveMessageUseCase } from '../../application/usecases/ReceiveMessageUseCase.js';
import { SOFIA_DEFINITION } from '../../agents/definitions/Sofia.js';
import { AppConfig } from '../../shared/config/AppConfig.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';
import { getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// ─── Infrastructure ────────────────────────────────────────────────────────
const quoteEngine = new SolarQuoteEngine();
const llmProvider = new GroqProvider();

// ─── WhatsApp / Meta sender (stateless utility) ───────────────────────────
async function sendWhatsAppMessage(phone: string, text: string): Promise<boolean> {
  const { accessToken, phoneNumberId } = AppConfig.meta;
  if (!accessToken) {
    logger.info(`[WhatsApp SIM] → +${phone}: ${text.substring(0, 80)}...`);
    return true;
  }

  // 1. Primary: WhatsApp Cloud API
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
      const data = await res.json() as any;
      if (!res.ok) {
        logger.error('[WhatsApp] Send failed', data);
        return false;
      }
      logger.info(`[WhatsApp] Sent successfully to +${phone}`, { messageId: data.messages?.[0]?.id });
      return true;
    } catch (err: any) {
      logger.error('[WhatsApp] Exception', { error: err.message });
      return false;
    }
  }

  // 2. Fallback: Messenger Graph API
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/me/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: phone },
        message: { text },
      }),
    });
    if (!res.ok) {
      const err = await res.json() as any;
      logger.error('[Messenger] Send failed', err);
      return false;
    }
    logger.info(`[Messenger] Sent successfully to PSID ${phone}`);
    return true;
  } catch (err: any) {
    logger.error('[Messenger] Exception', { error: err.message });
    return false;
  }
}

// ─── Repository selection (lazy — evaluated per-request) ─────────────────
function getRepos() {
  try {
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

// Keep initRepositories for backward compat (used in local test scripts)
let _convRepo: FirestoreConversationRepository | InMemoryConversationRepository | undefined;
let _leadRepo: FirestoreLeadRepository | InMemoryLeadRepository | undefined;

export function initRepositories(db: any | null) {
  if (db) {
    logger.info('[DI] initRepositories: Using Firestore repositories (multi-tenant)');
    _convRepo = new FirestoreConversationRepository(db);
    _leadRepo = new FirestoreLeadRepository(db);
  } else {
    logger.warn('[DI] initRepositories: Firestore not available — using InMemory repositories');
    _convRepo = new InMemoryConversationRepository();
    _leadRepo = new InMemoryLeadRepository();
  }
}

// ─── Use Case Factory ─────────────────────────────────────────────────────
export function buildReceiveMessageUseCase(): ReceiveMessageUseCase {
  // Use pre-initialized repos if available (local test), otherwise lazy-load
  const repos = (_convRepo && _leadRepo)
    ? { convRepo: _convRepo, leadRepo: _leadRepo }
    : getRepos();
  const orchestrator = new LLMOrchestrator(llmProvider, quoteEngine, repos.leadRepo, repos.convRepo);
  return new ReceiveMessageUseCase(repos.convRepo, orchestrator, SOFIA_DEFINITION, sendWhatsAppMessage);
}

export { _convRepo as convRepo, _leadRepo as leadRepo };

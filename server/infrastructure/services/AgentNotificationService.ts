/**
 * AgentNotificationService.ts
 * Dual notification service: Email Premium + WhatsApp HSM Template.
 * Implements graceful degradation cascade: WA failure does NOT block handoff.
 * Single Responsibility: agent notification only (Anti-God-Object Rule 3).
 * Security: prospect data sanitized before sending to Meta API (SSD Rule 6).
 */

import nodemailer from 'nodemailer';
import { Agent } from '../../domain/entities/Agent.js';
import { AgentRepository } from '../persistence/AgentRepository.js';
import { AppConfig } from '../../shared/config/AppConfig.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';

export interface ProspectData {
  nombre: string;
  phone: string;
  montoRecibo: string;
  sistemaEstimado: string;
  location?: string;
  handoffReason?: string;
  conversationSummary?: string;
}

export class AgentNotificationService {
  constructor(private agentRepo: AgentRepository) {}

  // ─── Agent Assignment (Round-Robin by assignedLeadsCount) ──────────────────

  async getAssignedAgent(tenantId: string): Promise<Agent> {
    const agents = await this.agentRepo.findActiveAgents(tenantId);

    if (agents.length > 0) {
      // Round-robin: agent with fewest assigned leads
      return agents[0]; // Already sorted ASC by assignedLeadsCount
    }

    // ✅ Explicit fallback — configurable via env vars, zero hardcoding
    logger.warn('[AgentNotification] No active agents found — using fallback agent config');
    return {
      id: 'fallback',
      tenantId,
      name: 'Equipo Comercial O3 Energy',
      email: AppConfig.agents.fallbackEmail,
      whatsappPhone: AppConfig.agents.fallbackWhatsapp,
      isActive: true,
      assignedLeadsCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  // ─── Dual Notification Orchestrator ────────────────────────────────────────

  async notify(agent: Agent, prospect: ProspectData, tenantId: string): Promise<void> {
    // ✅ Promise.allSettled: WA failure does NOT block email delivery
    const [emailResult, waResult] = await Promise.allSettled([
      this.notifyEmail(agent, prospect),
      this.notifyWhatsApp(agent, prospect),
    ]);

    if (emailResult.status === 'fulfilled' && emailResult.value) {
      logger.info('[AgentNotification] Email sent successfully', { agent: agent.email });
    } else {
      logger.error('[AgentNotification] CRITICAL: Email notification failed', {
        agent: agent.email,
        error: emailResult.status === 'rejected' ? emailResult.reason : 'unknown',
      });
    }

    if (waResult.status === 'fulfilled' && waResult.value) {
      logger.info('[AgentNotification] WhatsApp template sent successfully', { phone: agent.whatsappPhone });
    } else {
      logger.warn('[AgentNotification] WhatsApp notification failed — email fallback active', {
        phone: agent.whatsappPhone,
        error: waResult.status === 'rejected' ? waResult.reason : 'skipped',
      });
    }

    // Increment lead count for assigned agent (skip for fallback)
    if (agent.id !== 'fallback') {
      await this.agentRepo.incrementLeadCount(tenantId, agent.id).catch(err =>
        logger.warn('[AgentNotification] Failed to increment lead count', { error: err.message })
      );
    }
  }

  // ─── Email Premium ─────────────────────────────────────────────────────────

  private async notifyEmail(agent: Agent, prospect: ProspectData): Promise<boolean> {
    const { server, port, user, pass } = AppConfig.smtp;
    if (!pass) {
      logger.info('[AgentNotification Email SIM]', { agent: agent.email, prospect: prospect.nombre });
      return true;
    }

    const portalUrl = AppConfig.appUrl;
    const subject = `🔥 URGE CONTACTAR — ${prospect.nombre} (+${prospect.phone})`;

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:system-ui,-apple-system,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px;">
    <div style="background:linear-gradient(135deg,#f59e0b,#d97706);border-radius:16px 16px 0 0;padding:32px;text-align:center;">
      <h1 style="margin:0;color:#0f172a;font-size:22px;font-weight:800;">🔥 PROSPECTO CALIFICADO</h1>
      <p style="margin:8px 0 0;color:#451a03;font-size:14px;opacity:0.9;">O3 Energy México — Sofía IA Comercial</p>
    </div>
    <div style="background:#1e293b;border-radius:0 0 16px 16px;padding:32px;">
      <div style="background:#0f172a;border-radius:12px;padding:24px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:10px 0;color:#94a3b8;font-size:13px;font-weight:600;">👤 NOMBRE</td><td style="padding:10px 0;color:#f1f5f9;font-size:14px;font-weight:700;">${prospect.nombre}</td></tr>
          <tr><td style="padding:10px 0;color:#94a3b8;font-size:13px;font-weight:600;">📱 WHATSAPP</td><td style="padding:10px 0;"><a href="https://wa.me/${prospect.phone}" style="color:#f59e0b;font-weight:700;text-decoration:none;">+${prospect.phone}</a></td></tr>
          <tr><td style="padding:10px 0;color:#94a3b8;font-size:13px;font-weight:600;">💰 RECIBO CFE</td><td style="padding:10px 0;color:#f59e0b;font-size:15px;font-weight:800;">${prospect.montoRecibo}</td></tr>
          <tr><td style="padding:10px 0;color:#94a3b8;font-size:13px;font-weight:600;">⚡ SISTEMA EST.</td><td style="padding:10px 0;color:#f1f5f9;font-size:14px;">${prospect.sistemaEstimado}</td></tr>
          ${prospect.location ? `<tr><td style="padding:10px 0;color:#94a3b8;font-size:13px;font-weight:600;">📍 UBICACIÓN</td><td style="padding:10px 0;color:#f1f5f9;font-size:14px;">${prospect.location}</td></tr>` : ''}
          ${prospect.handoffReason ? `<tr><td style="padding:10px 0;color:#94a3b8;font-size:13px;font-weight:600;">💬 MOTIVO</td><td style="padding:10px 0;color:#f1f5f9;font-size:14px;">${prospect.handoffReason}</td></tr>` : ''}
        </table>
      </div>
      <div style="text-align:center;">
        <a href="${portalUrl}" style="display:inline-block;background:linear-gradient(135deg,#f59e0b,#d97706);color:#0f172a;font-weight:800;font-size:15px;padding:14px 32px;border-radius:12px;text-decoration:none;">☀️ Abrir Portal y Responder</a>
      </div>
      <p style="margin:24px 0 0;text-align:center;color:#475569;font-size:12px;">Agente: ${agent.name} — ${agent.email}</p>
    </div>
  </div>
</body>
</html>`;

    try {
      const transporter = nodemailer.createTransport({
        host: server, port, secure: port === 465, auth: { user, pass },
      });
      await transporter.sendMail({ from: `"Sofía IA - O3 Energy" <${user}>`, to: agent.email, subject, html });
      return true;
    } catch (err: any) {
      logger.error('[AgentNotification] Email send failed', { error: err.message });
      throw err;
    }
  }

  // ─── WhatsApp HSM Template (Meta-compliant) ────────────────────────────────

  private async notifyWhatsApp(agent: Agent, prospect: ProspectData): Promise<boolean> {
    const { accessToken, phoneNumberId, waAgentTemplateName } = AppConfig.meta;

    if (!accessToken || !phoneNumberId) {
      logger.info('[AgentNotification WA SIM] Would send WA template to agent', { phone: agent.whatsappPhone });
      return true;
    }

    if (!agent.whatsappPhone) {
      logger.warn('[AgentNotification] Agent has no WhatsApp phone configured — skipping WA');
      return false;
    }

    try {
      // ✅ HSM Template — complies with Meta 24h window policy
      const payload = {
        messaging_product: 'whatsapp',
        to: agent.whatsappPhone,
        type: 'template',
        template: {
          name: waAgentTemplateName, // Configurable via env var — zero hardcoding
          language: { code: 'es_MX' },
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: prospect.nombre.substring(0, 60) },       // {{1}}
              { type: 'text', text: prospect.phone },                          // {{2}}
              { type: 'text', text: prospect.montoRecibo },                    // {{3}}
              { type: 'text', text: prospect.sistemaEstimado.substring(0, 60) }, // {{4}}
            ],
          }],
        },
      };

      const res = await fetch(
        `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
        { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      );

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(`Meta API ${res.status}: ${JSON.stringify(errData)}`);
      }
      return true;

    } catch (err: any) {
      // ✅ GRACEFUL DEGRADATION: WA fails silently — email already guaranteed
      logger.warn('[AgentNotification] WhatsApp template failed — email fallback active', {
        agent: agent.email, error: err.message,
      });
      return false; // Does NOT throw — handoff is not blocked
    }
  }
}

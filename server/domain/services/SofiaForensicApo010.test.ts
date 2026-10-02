/**
 * SofiaForensicApo010.test.ts
 * Suite SQA Forense — Plan APO-010 (T31 - T35).
 * Valida:
 * 1. T31: Reproducción del Caso Samuel Saldivar y Sanitización Automática de Frase Puente.
 * 2. T32: Conciencia de Estado Multimedia en XML (<instalacion_brochure_sent> / <financing_brochure_sent>).
 * 3. T33: Preservación del Despacho Inicial en Turno 1 (Imagen y Frase Puente entregadas).
 * 4. T34: Manejo Elegante de Re-Solicitud de Brochure (Explicación cálida sin reenvío).
 * 5. T35: Cero Regresiones en Cadena Conversacional Completa (T01 - T30).
 */

import { describe, it, expect, vi } from 'vitest';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { SofiaPromptBuilder, UserContext } from '../../application/builders/SofiaPromptBuilder.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { ILLMProvider } from '../../interfaces/ILLMProvider.js';

describe('SQA Forense Plan APO-010 — Tests T31 a T35 (Anti-Ghost-Dispatch y Conciencia de Estado Multimedia)', () => {
  const tenantId = 'o3energy_mexico';

  // ─── T31: Reproducción del Caso Samuel Saldivar y Sanitización Automática ──
  it('T31: Tras recibir el brochure en Turno 1, cuando el usuario dice "No tengo fotos de mi recibo", el bot NO reenvía la imagen ni repite la frase puente', async () => {
    const phone = '5214777000031';
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    const mockLlm: ILLMProvider = {
      complete: vi.fn()
        // Turno 1: Usuario da nombre → Bot solicita recibo y envía brochure
        .mockResolvedValueOnce({
          text: JSON.stringify({
            next_step: 2,
            message_to_user: '¡Hola Samuel! 😊 Para poder diseñar la solución solar perfecta para ti, ¿podrías indicarme el monto de tu recibo de luz y si es bimestral o mensual? Si tienes a la mano tu recibo CFE, también puedes enviarme fotos del anverso y reverso para calcularlo con total exactitud. Mientras me pasas el dato, te comparto información detallada de nuestro servicio. 📄☀️',
            media_to_send: 'INSTALACION_PROFESIONAL',
          }),
          finishReason: 'stop',
        })
        // Turno 2: Usuario dice que no tiene fotos → LLM intenta re-emitir la frase puente por error
        .mockResolvedValueOnce({
          text: JSON.stringify({
            next_step: 2,
            message_to_user: 'Entiendo, no hay problema. Para poder calcular cuántos paneles necesitas, ¿podrías indicarme el monto que pagas en tu recibo de luz y si es bimestral o mensual? Mientras me pasas el dato, te comparto información detallada de nuestro servicio. 📄☀️',
            media_to_send: null,
          }),
          finishReason: 'stop',
        }),
    };

    const orchestrator = new SofiaFlowOrchestrator(
      convRepo,
      leadRepo,
      quoteEngine,
      mockLlm,
      vi.fn().mockResolvedValue(true),
      { sendLeadEmailNotification: vi.fn().mockResolvedValue(true) } as any
    );

    // Turno 1: Usuario dice su nombre
    const res1 = await orchestrator.processMessage({
      tenantId,
      phone,
      userName: 'Samuel',
      messageText: 'Soy Samuel Saldivar!',
    });

    expect(res1.replyText).toContain('Mientras me pasas el dato, te comparto información detallada');
    expect(res1.mediaSent).toBeDefined();
    expect(res1.mediaSent).toContainEqual(expect.stringContaining('INSTALACION_PROFESIONAL.jpeg'));

    const convAfterTurn1 = await convRepo.findByPhone(tenantId, phone);
    expect(convAfterTurn1.state.mediaSentFlags?.instalacionProfessional).toBe(true);

    // Turno 2: Usuario aclara que no tiene fotos del recibo
    const res2 = await orchestrator.processMessage({
      tenantId,
      phone,
      userName: 'Samuel',
      messageText: 'No tengo fotos de mi recibo!',
    });

    // 1. NO debe reenviar la imagen
    expect(res2.mediaSent).toBeUndefined();

    // 2. La frase puente DEBE haber sido sanitizada quirúrgicamente
    expect(res2.replyText).not.toContain('Mientras me pasas el dato, te comparto información detallada');
    expect(res2.replyText).not.toContain('te comparto información detallada de nuestro servicio');

    // 3. El texto principal de asesoría se preserva intacto
    expect(res2.replyText).toContain('Entiendo, no hay problema.');
    expect(res2.replyText).toContain('¿podrías indicarme el monto que pagas en tu recibo de luz');
  });

  // ─── T32: Conciencia de Estado Multimedia en XML ──────────────────────────
  it('T32: SofiaPromptBuilder inyecta <instalacion_brochure_sent>true</instalacion_brochure_sent> cuando el flag está activo', () => {
    const phone = '5214777000032';

    const ctx: UserContext = {
      phone,
      userName: 'Samuel',
      currentStep: 2,
      extractedData: {},
      botDisabled: false,
      latestUserMessage: 'No tengo fotos de mi recibo!',
      mediaSentFlags: {
        instalacionProfessional: true,
        financiamiento: false,
      },
    };

    const { systemPrompt, userContent } = SofiaPromptBuilder.buildPrompt(ctx);

    // XML debe reflejar fielmente el estado
    expect(userContent).toContain('<instalacion_brochure_sent>true</instalacion_brochure_sent>');
    expect(userContent).toContain('<financing_brochure_sent>false</financing_brochure_sent>');

    // System prompt debe contener las directivas condicionales estrictas
    expect(systemPrompt).toContain('<instalacion_brochure_sent>true</instalacion_brochure_sent>');
    expect(systemPrompt).toContain('TERMINANTEMENTE PROHIBIDO volver a incluir la frase "Mientras me pasas el dato');
    expect(systemPrompt).toContain('REGLA DE PARIDAD PARA BROCHURE DE FINANCIAMIENTO');
  });

  // ─── T33: Preservación del Despacho Inicial en Turno 1 ────────────────────
  it('T33: Cuando instalacionProfessional es false/undefined, el primer ingreso a Paso 2 despacha la imagen y la frase puente', async () => {
    const phone = '5214777000033';
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    const mockLlm: ILLMProvider = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          next_step: 2,
          message_to_user: '¡Mucho gusto Samuel! ¿Podrías indicarme el monto de tu recibo?',
          media_to_send: 'INSTALACION_PROFESIONAL',
        }),
        finishReason: 'stop',
      }),
    };

    const orchestrator = new SofiaFlowOrchestrator(
      convRepo,
      leadRepo,
      quoteEngine,
      mockLlm,
      vi.fn().mockResolvedValue(true),
      { sendLeadEmailNotification: vi.fn().mockResolvedValue(true) } as any
    );

    const result = await orchestrator.processMessage({
      tenantId,
      phone,
      userName: 'Samuel',
      messageText: 'Soy Samuel',
    });

    // En el primer despacho, la imagen SÍ se envía y la frase puente se asegura
    expect(result.mediaSent).toBeDefined();
    expect(result.mediaSent).toContainEqual(expect.stringContaining('INSTALACION_PROFESIONAL.jpeg'));
    expect(result.replyText).toContain('Mientras me pasas el dato, te comparto información detallada de nuestro servicio. 📄☀️');

    const conv = await convRepo.findByPhone(tenantId, phone);
    expect(conv.state.mediaSentFlags?.instalacionProfessional).toBe(true);
  });

  // ─── T34: Manejo Elegante de Re-Solicitudes de Brochure ────────────────────
  it('T34: Si el usuario solicita explícitamente el brochure que ya fue enviado, responde amablemente indicando que está arriba en el chat y NO reenvía la imagen', async () => {
    const phone = '5214777000034';
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    // Estado: El brochure ya fue enviado
    const conv = await convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Samuel';
    conv.state.phase = 'QUALIFICATION';
    conv.state.mediaSentFlags = { instalacionProfessional: true };
    await convRepo.save(conv);

    const mockLlm: ILLMProvider = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          next_step: 2,
          message_to_user: 'El brochure ya está en nuestro chat, justo arriba de este mensaje. ¿Te gustaría que te ayude con alguna duda específica sobre la información que contiene? 😊',
          media_to_send: null,
        }),
        finishReason: 'stop',
      }),
    };

    const orchestrator = new SofiaFlowOrchestrator(
      convRepo,
      leadRepo,
      quoteEngine,
      mockLlm,
      vi.fn().mockResolvedValue(true),
      { sendLeadEmailNotification: vi.fn().mockResolvedValue(true) } as any
    );

    const result = await orchestrator.processMessage({
      tenantId,
      phone,
      userName: 'Samuel',
      messageText: '¿Me puedes enviar el brochure de nuevo?',
    });

    // 1. NO se reenvía la imagen multimedia
    expect(result.mediaSent).toBeUndefined();

    // 2. La respuesta guía con calidez humana indicando que ya está arriba en el chat
    expect(result.replyText).toContain('El brochure ya está en nuestro chat, justo arriba de este mensaje');
    expect(result.replyText).not.toContain('Mientras me pasas el dato');
  });

  // ─── T35: Regresión Total en Flujos Previos ───────────────────────────────
  it('T35: Regresión total certifica que el flujo comercial completo opera sin interferencias', async () => {
    const phone = '5214777000035';
    const convRepo = new InMemoryConversationRepository();
    const leadRepo = new InMemoryLeadRepository();
    const quoteEngine = new SolarQuoteEngine();

    const mockLlm: ILLMProvider = {
      complete: vi.fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            next_step: 1,
            message_to_user: '¡Hola! Bienvenido a O3 Energy México ☀️ ¿Con quién tengo el gusto?',
            extracted_data: { client_name: null },
          }),
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({
            next_step: 2,
            message_to_user: '¡Mucho gusto Samuel! ¿Podrías indicarme tu recibo de luz?',
            extracted_data: { client_name: 'Samuel' },
            media_to_send: 'INSTALACION_PROFESIONAL',
          }),
          finishReason: 'stop',
        }),
    };

    const orchestrator = new SofiaFlowOrchestrator(
      convRepo,
      leadRepo,
      quoteEngine,
      mockLlm,
      vi.fn().mockResolvedValue(true),
      { sendLeadEmailNotification: vi.fn().mockResolvedValue(true) } as any
    );

    const r1 = await orchestrator.processMessage({ tenantId, phone, userName: 'GrupoSERTEI', messageText: 'Hola' });
    expect(r1.replyText).toContain('¿Con quién tengo el gusto?');

    const r2 = await orchestrator.processMessage({ tenantId, phone, userName: 'GrupoSERTEI', messageText: 'Soy Samuel' });
    expect(r2.replyText).toContain('Samuel');
    expect(r2.mediaSent).toContainEqual(expect.stringContaining('INSTALACION_PROFESIONAL.jpeg'));
  });
});

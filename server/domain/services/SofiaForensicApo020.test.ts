/**
 * SofiaForensicApo020.test.ts
 * Batería de Pruebas SQA Forense — Expediente APO-020
 * Validación de:
 * - T68: Inyección estricta de thinkingBudget: 0 en Gemini Fallback y validación de payload.
 * - T69: Red de seguridad U-First determinista ante fallo de LLM cuando el recibo ya fue extraído ($148,228 MXN).
 * - T70: Fallback secundario seguro cuando el LLM falla sin recibo extraído.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResilientLLMProvider } from '../../infrastructure/llm/ResilientLLMProvider.js';
import { ReceiveMessageUseCase } from '../../application/usecases/ReceiveMessageUseCase.js';
import { SofiaFlowOrchestrator } from '../../application/orchestration/SofiaFlowOrchestrator.js';
import { InMemoryConversationRepository, InMemoryLeadRepository } from '../../infrastructure/persistence/Repositories.js';
import { SolarQuoteEngine } from '../../infrastructure/engines/SolarQuoteEngine.js';
import { LLMCircuitBreaker } from '../../infrastructure/llm/LLMCircuitBreaker.js';
import { ILLMProvider } from '../../interfaces/ILLMProvider.js';

describe('SQA Forense Plan APO-020 — Tests T68 a T70 (Resiliencia de Latencia y Red U-First)', () => {
  let convRepo: InMemoryConversationRepository;
  let leadRepo: InMemoryLeadRepository;
  let quoteEngine: SolarQuoteEngine;

  beforeEach(() => {
    convRepo = new InMemoryConversationRepository();
    leadRepo = new InMemoryLeadRepository();
    quoteEngine = new SolarQuoteEngine();
  });

  // ─── T68: Inyección Estricta de thinkingBudget: 0 en Gemini Fallback ─────────
  it('T68 (Payload Gemini sin Thinking): Inyecta thinkingBudget: 0 en generationConfig y procesa respuesta rápida', async () => {
    let capturedBody: any = null;

    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      next_step: 3,
                      message_to_user: '¡Gracias Héctor! He analizado tu recibo. ¿Qué tipo de techo tienes?',
                      extracted_data: { client_name: 'Héctor Alvarez' },
                    }),
                  },
                ],
              },
            },
          ],
        }),
      };
    });

    const resilientLLM = new ResilientLLMProvider(
      undefined,
      mockFetch as any,
      3500
    );

    const start = Date.now();
    const result = await (resilientLLM as any).callGeminiFallback(
      [
        { role: 'system', content: 'Eres Sofía.' },
        { role: 'user', content: 'Adjunto mi recibo de luz.' },
      ],
      0.2
    );
    const durationMs = Date.now() - start;

    expect(capturedBody).not.toBeNull();
    // Aserción 1: Directiva thinkingBudget: 0 presente
    expect(capturedBody.generationConfig.thinkingConfig).toBeDefined();
    expect(capturedBody.generationConfig.thinkingConfig.thinkingBudget).toBe(0);

    // Aserción 2: Formato JSON estructurado solicitado
    expect(capturedBody.generationConfig.responseMimeType).toBe('application/json');
    expect(capturedBody.generationConfig.temperature).toBe(0.2);

    // Aserción 3: Ejecución inmediata (< 3000 ms)
    expect(durationMs).toBeLessThan(3000);
    expect(result.text).toContain('¡Gracias Héctor!');
  });

  // ─── T69: Red de Seguridad U-First Determinista con Recibo Extraído ─────────
  it('T69 (Red U-First Determinista): Responde de inmediato con monto extraído ($148,228) y avanza a techo si el LLM falla', async () => {
    // Configurar repositorio con chat existente y nombre registrado
    const phone = '5214777241148';
    const tenantId = 'o3energy_mexico';
    const conv = await convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Héctor Alvarez';
    conv.state.phase = 'QUALIFICATION';
    await convRepo.save(conv);

    // Mock de LLM que falla catastróficamente (simulando timeout / Circuit Breaker en OPEN)
    const failingLLM: ILLMProvider = {
      complete: vi.fn().mockRejectedValue(new Error('Circuit Breaker OPEN: All LLMs timed out')),
    };

    const orchestrator = new SofiaFlowOrchestrator(
      convRepo,
      leadRepo,
      quoteEngine,
      failingLLM,
      async () => true,
      { sendLeadNotification: async () => true }
    );

    const sendWhatsAppMock = vi.fn().mockResolvedValue(true);
    const sendWhatsAppMediaMock = vi.fn().mockResolvedValue(true);

    const useCase = new ReceiveMessageUseCase(
      convRepo,
      orchestrator,
      sendWhatsAppMock,
      sendWhatsAppMediaMock
    );

    // Ejecutar con recibo de Pozo 3 ya extraído ($148,228 MXN mensual)
    const result = await useCase.execute({
      tenantId,
      phone,
      name: 'Héctor Alvarez',
      text: '',
      inboundTimestamp: '2026-10-12T22:42:56.000Z',
      // Simulamos que la fase 1 de visión ya extrajo los datos:
      mediaAttachments: [],
    });

    // Simulamos el caso donde extractedBill fue poblado por analyzeReceipt:
    // Para probar la función completa de degradación, invocamos el caso de uso pasando extractedBill directo
    const directResult = await useCase['orchestrator']['processMessage']({
      tenantId,
      phone,
      userName: 'Héctor Alvarez',
      messageText: 'Adjunto mi recibo de luz',
      extractedBill: {
        amount: 148228,
        frequency: 'mensual',
        tariff: 'GDMTH',
        receiptSource: 'image',
        bothPagesAnalyzed: true,
      },
    }).catch(async () => {
      // Simular la captura del bloque catch en ReceiveMessageUseCase
      return null;
    });

    expect(directResult).toBeNull(); // Se confirma que el LLM falló

    // Ahora probamos la ejecución del useCase con LLM fallando y extractedData inyectado
    // Simulamos el extractor retornando éxito:
    const mockExtractor: any = {
      analyzeReceipt: vi.fn().mockResolvedValue({
        status: 'SUCCESS',
        documentType: 'CFE_ANVERSO',
        data: {
          tipoDocumento: 'CFE_ANVERSO',
          montoTotal: 148228,
          periodo: 'mensual',
          tarifa: 'GDMTH',
          confianza: 'alta',
        },
      }),
    };

    const mockMediaService: any = {
      downloadMedia: vi.fn().mockResolvedValue({
        success: true,
        buffer: Buffer.from('fake-pozo3-image'),
        mimeType: 'image/jpeg',
        filename: '02. Pozo 3 - page-0001.jpg',
        fileSize: 508000,
      }),
    };

    const resilientUseCase = new ReceiveMessageUseCase(
      convRepo,
      orchestrator,
      sendWhatsAppMock,
      sendWhatsAppMediaMock,
      mockMediaService,
      mockExtractor
    );

    const useCaseOutput = await resilientUseCase.execute({
      tenantId,
      phone,
      name: 'Héctor Alvarez',
      text: '',
      inboundTimestamp: '2026-10-12T22:42:56.000Z',
      mediaId: 'media-pozo-3-id',
      mediaType: 'image',
      mediaFilename: '02. Pozo 3 - page-0001.jpg',
    });

    // Aserción 1: La respuesta contiene el monto extraído
    expect(useCaseOutput.reply).toContain('148,228');

    // Aserción 2: La respuesta personaliza por nombre
    expect(useCaseOutput.reply).toContain('Héctor Alvarez');

    // Aserción 3: Pregunta por el techo (concreto, lámina o teja)
    expect(useCaseOutput.reply).toMatch(/techo|concreto|lámina|teja/i);

    // Aserción 4: NUNCA contiene el mensaje de intermitencia técnica
    expect(useCaseOutput.reply).not.toContain('intermitencia técnica');

    // Aserción 5: El estado de Firestore persistió el monto y avanzó a TECHNICAL_SURVEY
    const updatedConv = await convRepo.findByPhone(tenantId, phone);
    expect(updatedConv.state.monthlyBill).toBe(148228);
    expect(updatedConv.state.phase).toBe('TECHNICAL_SURVEY');
    expect(updatedConv.state.billFrequency).toBe('mensual');
  });

  // ─── T70: Fallback Secundario cuando NO hay Recibo Extraído ─────────────────
  it('T70 (Fallback Secundario): Activa mensaje de intermitencia si el LLM falla sin recibo extraído', async () => {
    const phone = '5214777999970';
    const tenantId = 'o3energy_mexico';
    const conv = await convRepo.findByPhone(tenantId, phone);
    conv.nombre = 'Carlos Test';
    conv.state.phase = 'GREETING';
    await convRepo.save(conv);

    const failingLLM: ILLMProvider = {
      complete: vi.fn().mockRejectedValue(new Error('Complete network outage')),
    };

    const orchestrator = new SofiaFlowOrchestrator(
      convRepo,
      leadRepo,
      quoteEngine,
      failingLLM,
      async () => true,
      { sendLeadNotification: async () => true }
    );

    const sendWhatsAppMock = vi.fn().mockResolvedValue(true);
    const sendWhatsAppMediaMock = vi.fn().mockResolvedValue(true);

    const useCase = new ReceiveMessageUseCase(
      convRepo,
      orchestrator,
      sendWhatsAppMock,
      sendWhatsAppMediaMock
    );

    const output = await useCase.execute({
      tenantId,
      phone,
      name: 'Carlos Test',
      text: 'Hola, tengo una pregunta general',
      inboundTimestamp: '2026-10-12T22:45:00.000Z',
    });

    // Sin recibo extraído, se emite el fallback de intermitencia sin romper el flujo
    expect(output.reply).toContain('pequeña intermitencia técnica');
    expect(output.reply).toContain('Carlos Test');
  });
});

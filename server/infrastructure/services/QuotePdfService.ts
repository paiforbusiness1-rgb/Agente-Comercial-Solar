/**
 * QuotePdfService.ts
 * Dynamic PDF Generation Microservice for O3 Energy México.
 * RUTA A Implementation: Uses pdf-lib to programmatically generate genuine, binary PDF files
 * on-the-fly containing personalized customer quote details and mandatory Section 5 disclaimer.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import { AppConfig } from '../../shared/config/AppConfig.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';
import { getApps } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

export interface QuotePdfDTO {
  clientName: string;
  clientPhone: string;
  monthlyBillMxn: number;
  panelsCount: number;
  systemPowerKwp: number;
  totalCostMxn: number;
  monthlySavingsMxn: number;
  annualSavingsMxn: number;
  roofType?: string;
  meterDistance?: string;
  location?: string;
}

export interface QuotePdfResult {
  success: boolean;
  pdfUrl?: string;
  pdfBuffer?: Buffer;
  textSummary: string;
}

export class QuotePdfService {
  /**
   * Generates an authentic binary PDF file on-the-fly matching O3 Energy corporate layout.
   */
  public static async generateQuote(dto: QuotePdfDTO): Promise<QuotePdfResult> {
    const formattedCost = `$${dto.totalCostMxn.toLocaleString('es-MX')} MXN (IVA incluido)`;
    const formattedMonthlySavings = `$${dto.monthlySavingsMxn.toLocaleString('es-MX')} MXN/mes`;
    const formattedAnnualSavings = `$${dto.annualSavingsMxn.toLocaleString('es-MX')} MXN/año`;

    const textSummary = `📋 *PRESUPUESTO PRELIMINAR DE SISTEMA SOLAR* ☀️
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 *Cliente:* ${dto.clientName}
📱 *Contacto:* ${dto.clientPhone}
📍 *Ubicación:* ${dto.location || 'Chihuahua, Chih.'}

⚡ *DIAGNÓSTICO ENERGÉTICO:*
• Consumo reportado: $${dto.monthlyBillMxn.toLocaleString('es-MX')} MXN/mes
• Sistema sugerido: *${dto.panelsCount} Paneles Solares* de Alta Eficiencia (${dto.systemPowerKwp.toFixed(1)} kWp)

💰 *INVERSIÓN Y AHORRO ESTIMADO:*
• Inversión Total: *${formattedCost}*
• Ahorro estimado mensual: *${formattedMonthlySavings}* (~90% de reducción)
• Ahorro estimado anual: *${formattedAnnualSavings}*
• Retorno de Inversión (ROI): *~2.5 a 3 años*

🎁 *INCLUYE:*
✅ Paneles solares nivel Tier 1 con 25 años de garantía
✅ Microinversores inteligentes
✅ Trámite de interconexión ante CFE (100% incluido)
✅ Estructura de aluminio anodizado anticorrosivo
✅ Instalación técnica profesional certificada

⚠️ *NOTA IMPORTANTE:*
_Este presupuesto es una estimación aproximada basada en tu consumo reportado. El presupuesto real y final se confirmará tras la visita técnica Gratuita de nuestros ingenieros a tu domicilio._`;

    try {
      // 1. Create a new PDF Document
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595.28, 841.89]); // A4 Size in points
      const { width, height } = page.getSize();

      // Embed Fonts
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontOblique = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

      // Corporate Colors
      const primaryOrange = rgb(0.92, 0.43, 0.12); // O3 Orange
      const darkNavy = rgb(0.1, 0.15, 0.25);      // O3 Navy
      const lightBg = rgb(0.95, 0.96, 0.98);       // Card background
      const textDark = rgb(0.2, 0.2, 0.2);

      let y = height - 50;

      // Header Banner Background
      page.drawRectangle({
        x: 0,
        y: height - 100,
        width,
        height: 100,
        color: darkNavy,
      });

      // Header Title
      page.drawText('O3 ENERGY MÉXICO', {
        x: 40,
        y: height - 45,
        size: 22,
        font: fontBold,
        color: primaryOrange,
      });

      page.drawText('PRESUPUESTO PRELIMINAR DE SISTEMA FOTOVOLTAICO', {
        x: 40,
        y: height - 70,
        size: 11,
        font: fontRegular,
        color: rgb(1, 1, 1),
      });

      page.drawText(`Fecha: ${new Date().toLocaleDateString('es-MX')}`, {
        x: width - 180,
        y: height - 45,
        size: 10,
        font: fontRegular,
        color: rgb(0.9, 0.9, 0.9),
      });

      y = height - 130;

      // Client Information Section Box
      page.drawRectangle({
        x: 40,
        y: y - 70,
        width: width - 80,
        height: 75,
        color: lightBg,
        borderColor: rgb(0.85, 0.85, 0.85),
        borderWidth: 1,
      });

      page.drawText('DATOS DEL CLIENTE Y PROYECTO', {
        x: 55,
        y: y - 18,
        size: 11,
        font: fontBold,
        color: darkNavy,
      });

      page.drawText(`Cliente: ${dto.clientName}`, { x: 55, y: y - 38, size: 10, font: fontRegular, color: textDark });
      page.drawText(`Teléfono: +${dto.clientPhone}`, { x: 55, y: y - 55, size: 10, font: fontRegular, color: textDark });
      page.drawText(`Ubicación: ${dto.location || 'Chihuahua, Chih.'}`, { x: 300, y: y - 38, size: 10, font: fontRegular, color: textDark });
      page.drawText(`Tipo de Techo: ${dto.roofType || 'Residencial / Losa'}`, { x: 300, y: y - 55, size: 10, font: fontRegular, color: textDark });

      y -= 105;

      // System Dimensioning & Costs Card
      page.drawRectangle({
        x: 40,
        y: y - 145,
        width: width - 80,
        height: 150,
        color: rgb(1, 1, 1),
        borderColor: primaryOrange,
        borderWidth: 1.5,
      });

      page.drawText('RESUMEN DE COTIZACIÓN Y AHORRO ENERGÉTICO', {
        x: 55,
        y: y - 22,
        size: 12,
        font: fontBold,
        color: primaryOrange,
      });

      page.drawText(`Consumo Reportado CFE: $${dto.monthlyBillMxn.toLocaleString('es-MX')} MXN/mes`, { x: 55, y: y - 48, size: 10, font: fontRegular, color: textDark });
      page.drawText(`Sistema Sugerido: ${dto.panelsCount} Paneles Solares (${dto.systemPowerKwp.toFixed(1)} kWp)`, { x: 55, y: y - 68, size: 11, font: fontBold, color: darkNavy });
      page.drawText(`Inversión Total Estimada: ${formattedCost}`, { x: 55, y: y - 88, size: 12, font: fontBold, color: primaryOrange });
      page.drawText(`Ahorro Estimado Mensual: ${formattedMonthlySavings} (~90% reducción)`, { x: 55, y: y - 108, size: 10, font: fontRegular, color: textDark });
      page.drawText(`Ahorro Estimado Anual: ${formattedAnnualSavings}`, { x: 55, y: y - 128, size: 10, font: fontRegular, color: textDark });

      y -= 175;

      // Deliverables List
      page.drawText('LO QUE INCLUYE NUESTRO SERVICIO INTEGRAL:', { x: 40, y, size: 11, font: fontBold, color: darkNavy });
      y -= 20;

      const items = [
        '• Paneles solares de alta eficiencia Tier 1 con 25 años de garantía',
        '• Microinversores inteligentes con monitoreo en tiempo real',
        '• Estrutura de aluminio anodizado altamente resistente y anticorrosiva',
        '• Trámite 100% completo de interconexión ante CFE',
        '• Instalación profesional por Ingenieros Certificados de O3 Energy',
      ];

      items.forEach(item => {
        page.drawText(item, { x: 50, y, size: 9.5, font: fontRegular, color: textDark });
        y -= 18;
      });

      y -= 20;

      // Section 5 Mandatory Disclaimer Box (ROBUST SQA & HRU REQUIREMENT)
      page.drawRectangle({
        x: 40,
        y: y - 60,
        width: width - 80,
        height: 65,
        color: rgb(0.99, 0.95, 0.9),
        borderColor: primaryOrange,
        borderWidth: 1,
      });

      page.drawText('NOTA IMPORTANTE Y CONFIRMACIÓN DE VISITA TÉCNICA (SECCIÓN 5):', {
        x: 52,
        y: y - 18,
        size: 9.5,
        font: fontBold,
        color: primaryOrange,
      });

      const noteText = 'Este presupuesto es una estimación aproximada basada en tu consumo reportado. El presupuesto real\ny final se confirmará tras la visita técnica GRATUITA de nuestros Ingenieros al sitio para evaluar inclinación,\nsombras y trayectoria eléctrica.';
      
      const lines = noteText.split('\n');
      let noteY = y - 32;
      lines.forEach(l => {
        page.drawText(l, { x: 52, y: noteY, size: 8.5, font: fontOblique, color: darkNavy });
        noteY -= 12;
      });

      // Footer
      page.drawText('O3 Energy México — Líderes en Ingeniería Fotovoltaica | www.o3energy.mx', {
        x: 100,
        y: 25,
        size: 8.5,
        font: fontRegular,
        color: rgb(0.5, 0.5, 0.5),
      });

      // 2. Serialize PDF Document to Uint8Array / Buffer
      const pdfBytes = await pdfDoc.save();
      const pdfBuffer = Buffer.from(pdfBytes);

      const fileName = `Cotizacion_Solar_${dto.panelsCount}_Paneles_${dto.clientPhone.slice(-4)}.pdf`;
      let pdfUrl = `${AppConfig.mediaBaseUrl}/${fileName}`;

      // Save locally to public static directory
      try {
        const publicDir = path.join(process.cwd(), 'public', 'images');
        if (!fs.existsSync(publicDir)) {
          fs.mkdirSync(publicDir, { recursive: true });
        }
        const filePath = path.join(publicDir, fileName);
        fs.writeFileSync(filePath, pdfBuffer);
      } catch (e: any) {
        logger.warn('[QuotePdfService] Local public write warning:', e.message);
      }

      // 3. Persistent Cloud Storage (Firebase Storage) if available in production environment
      try {
        if (getApps().length > 0) {
          const storage = getStorage();
          const bucket = storage.bucket();
          const fileRef = bucket.file(`cotizaciones/${fileName}`);
          await fileRef.save(pdfBuffer, { contentType: 'application/pdf', public: true });
          pdfUrl = `https://storage.googleapis.com/${bucket.name}/cotizaciones/${fileName}`;
          logger.info(`[QuotePdfService] Uploaded PDF to Cloud Storage: ${pdfUrl}`);
        }
      } catch (cloudErr: any) {
        logger.info('[QuotePdfService] Using local media URL fallback for PDF.');
      }

      logger.info(`[QuotePdfService] Generated dynamic PDF successfully: ${pdfUrl}`);

      return {
        success: true,
        pdfUrl,
        pdfBuffer,
        textSummary,
      };
    } catch (error) {
      logger.error('Error generating Quote PDF in QuotePdfService:', error);
      // Fallback (SQA Rule 5): Never throw unhandled 500 error, return text summary fallback
      return {
        success: false,
        textSummary,
      };
    }
  }
}

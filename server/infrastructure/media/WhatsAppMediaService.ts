/**
 * WhatsAppMediaService.ts
 * Servicio de Descarga Segura de Archivos Multimedia desde Meta Cloud API.
 * Cumplimiento:
 * - Regla 6 (SSD): Size Guard de 5 MB contra DoS/OOM y aislamiento de credenciales.
 * - Regla 3 (Anti-God-Object): Microservicio dedicado a operaciones I/O de medios.
 */

import { AppConfig } from '../../shared/config/AppConfig.js';
import { logger } from '../../shared/logger/ConsoleLogger.js';

export type MediaDownloadResult =
  | { success: true; buffer: Buffer; mimeType: string; filename?: string; fileSize: number }
  | { success: false; error: 'size_exceeded' | 'fetch_failed' | 'not_configured'; message: string; fileSize?: number };

export class WhatsAppMediaService {
  private fetchFn: typeof fetch;
  private token?: string;

  constructor(customFetch?: typeof fetch, token?: string) {
    this.fetchFn = customFetch || fetch;
    this.token = token;
  }

  /**
   * Descarga un archivo multimedia de Meta Graph API con validación previa de tamaño
   * @param mediaId ID del objeto multimedia entregado por el webhook de WhatsApp
   * @param suggestedFilename Nombre sugerido por el webhook (opcional)
   */
  async downloadMedia(mediaId: string, suggestedFilename?: string): Promise<MediaDownloadResult> {
    const token = this.token || AppConfig.meta.accessToken || (AppConfig.env === 'test' ? 'test-mock-meta-token' : '');
    if (!token) {
      logger.warn('[WhatsAppMediaService] WhatsApp Access Token no configurado');
      return {
        success: false,
        error: 'not_configured',
        message: 'Token de WhatsApp no disponible para descargar medios',
      };
    }

    try {
      // 1. Consultar metadatos del medio en Meta Graph API
      const metadataRes = await this.fetchFn(`https://graph.facebook.com/v20.0/${mediaId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!metadataRes.ok) {
        logger.error('[WhatsAppMediaService] Error al obtener metadatos de medio', {
          mediaId,
          status: metadataRes.status,
        });
        return {
          success: false,
          error: 'fetch_failed',
          message: `Error Meta API: ${metadataRes.statusText}`,
        };
      }

      const metadata = (await metadataRes.json()) as {
        url?: string;
        mime_type?: string;
        file_size?: number;
        id?: string;
      };

      if (!metadata.url) {
        logger.error('[WhatsAppMediaService] Metadatos de medio no contienen URL', { mediaId });
        return {
          success: false,
          error: 'fetch_failed',
          message: 'URL de descarga de medio ausente en respuesta de Meta',
        };
      }

      const fileSize = metadata.file_size || 0;
      const maxSize = AppConfig.media.maxSizeBytes;

      // Refinamiento 1 (SSD): Size Guard preventivo antes de descargar el binario
      if (fileSize > maxSize) {
        logger.warn('[WhatsAppMediaService] Archivo excede límite de tamaño permitido', {
          mediaId,
          fileSize,
          maxSize,
        });
        return {
          success: false,
          error: 'size_exceeded',
          fileSize,
          message: 'El archivo es demasiado pesado para procesarlo directamente (máximo 5 MB)',
        };
      }

      // 2. Descargar el binario del archivo
      const binaryRes = await this.fetchFn(metadata.url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!binaryRes.ok) {
        logger.error('[WhatsAppMediaService] Error al descargar binario', {
          mediaId,
          status: binaryRes.status,
        });
        return {
          success: false,
          error: 'fetch_failed',
          message: `Error al transferir archivo binario: ${binaryRes.statusText}`,
        };
      }

      const arrayBuffer = await binaryRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Verificación defensiva secundaria de tamaño en memoria
      if (buffer.length > maxSize) {
        logger.warn('[WhatsAppMediaService] Buffer descargado excede límite de seguridad', {
          length: buffer.length,
          maxSize,
        });
        return {
          success: false,
          error: 'size_exceeded',
          fileSize: buffer.length,
          message: 'El archivo es demasiado pesado para procesarlo directamente (máximo 5 MB)',
        };
      }

      logger.info('[WhatsAppMediaService] Medio descargado exitosamente', {
        mediaId,
        sizeBytes: buffer.length,
        mimeType: metadata.mime_type,
      });

      return {
        success: true,
        buffer,
        mimeType: metadata.mime_type || 'application/octet-stream',
        filename: suggestedFilename,
        fileSize: buffer.length,
      };
    } catch (err: any) {
      logger.error('[WhatsAppMediaService] Excepción durante descarga de medio', {
        mediaId,
        error: err.message,
      });
      return {
        success: false,
        error: 'fetch_failed',
        message: err.message || 'Excepción desconocida al descargar medio',
      };
    }
  }
}

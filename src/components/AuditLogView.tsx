/**
 * src/components/AuditLogView.tsx
 * Glassmorphic Audit Log Dashboard Component for O3 Energy México.
 * Standardized under ISO/IEC 27034-1 & Regla 8 (Chain of Custody).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ShieldCheck, Search, Filter, RefreshCw, ChevronLeft, ChevronRight, Clock, User, Trash2, RotateCcw, AlertTriangle, Layers, Server } from 'lucide-react';

export interface AuditLogEntry {
  id?: string;
  eventType: 'CHAT_SOFT_DELETED' | 'CHAT_RESTORED' | 'USER_LOGIN' | 'USER_LOGOUT' | 'LEAD_STATUS_UPDATED' | 'TRASH_PURGED';
  userEmail: string;
  userRole: string;
  resourceId: string;
  details?: Record<string, any>;
  ipAddress?: string;
  tenantId: string;
  timestamp: string;
}

interface PaginatedLogs {
  data: AuditLogEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface AuditLogViewProps {
  isDarkMode: boolean;
  showToast: (msg: string) => void;
}

export const AuditLogView: React.FC<AuditLogViewProps> = ({ isDarkMode, showToast }) => {
  const [logsState, setLogsState] = useState<PaginatedLogs>({
    data: [],
    total: 0,
    page: 1,
    limit: 15,
    totalPages: 1,
  });

  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedEventType, setSelectedEventType] = useState<string>('ALL');
  const [isPurging, setIsPurging] = useState(false);
  const [showPurgeModal, setShowPurgeModal] = useState(false);

  const fetchAuditLogs = useCallback(async (page: number = 1, eventType?: string) => {
    setIsLoading(true);
    try {
      let url = `/api/v2/audit-logs?page=${page}&limit=15`;
      if (eventType && eventType !== 'ALL') {
        url += `&eventType=${eventType}`;
      }

      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });

      if (res.ok) {
        const data: PaginatedLogs = await res.json();
        setLogsState(data);
      } else {
        showToast('Error al cargar la bitácora de auditoría');
      }
    } catch (err) {
      showToast('Error de red al consultar la bitácora');
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchAuditLogs(1, selectedEventType);
  }, [fetchAuditLogs, selectedEventType]);

  const handlePurgeExpired = async () => {
    setIsPurging(true);
    try {
      const res = await fetch('/api/v2/chats/purge-expired', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ retentionDays: 30 }),
      });

      const data = await res.json();

      if (res.ok) {
        showToast(`🧹 ${data.message}`);
        fetchAuditLogs(1, selectedEventType);
      } else {
        showToast(data.error || 'Error al ejecutar la purga de la papelera');
      }
    } catch (err) {
      showToast('Error de conexión al purgar la papelera');
    } finally {
      setIsPurging(false);
      setShowPurgeModal(false);
    }
  };

  const filteredLogs = logsState.data.filter((log) => {
    const q = searchQuery.toLowerCase();
    return (
      (log.userEmail || '').toLowerCase().includes(q) ||
      (log.resourceId || '').toLowerCase().includes(q) ||
      (log.ipAddress || '').toLowerCase().includes(q) ||
      (log.eventType || '').toLowerCase().includes(q)
    );
  });

  const getEventBadge = (type: AuditLogEntry['eventType']) => {
    switch (type) {
      case 'CHAT_SOFT_DELETED':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-lg text-[10px] font-bold bg-red-500/10 text-red-400 border border-red-500/20">
            <Trash2 className="h-3 w-3 mr-1" />
            SOFT DELETE CHAT
          </span>
        );
      case 'CHAT_RESTORED':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-lg text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <RotateCcw className="h-3 w-3 mr-1" />
            CHAT RESTAURADO
          </span>
        );
      case 'TRASH_PURGED':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-lg text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <AlertTriangle className="h-3 w-3 mr-1" />
            PURGA 30 DÍAS
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-lg text-[10px] font-bold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            <ShieldCheck className="h-3 w-3 mr-1" />
            {type}
          </span>
        );
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden p-6 space-y-6 relative font-sans">
      
      {/* Purge Modal */}
      <AnimatePresence>
        {showPurgeModal && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-slate-900 border border-slate-800 rounded-3xl p-6 max-w-sm w-full shadow-2xl space-y-4"
            >
              <div className="flex items-center space-x-3 text-amber-400">
                <div className="p-2.5 rounded-2xl bg-amber-500/10 border border-amber-500/20">
                  <AlertTriangle className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="font-bold text-base text-white">Purga de Papelera (&gt; 30 días)</h3>
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider font-mono">Refinamiento A (TTL)</span>
                </div>
              </div>

              <p className="text-xs text-slate-300 leading-relaxed">
                ¿Deseas ejecutar la limpieza física permanente de chats archivados que tengan más de 30 días en la Papelera de Reciclaje? Esta acción liberará espacio y no se puede deshacer.
              </p>

              <div className="flex justify-end space-x-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowPurgeModal(false)}
                  className="px-4 py-2.5 rounded-xl border border-slate-700 text-xs font-semibold text-slate-300 hover:bg-slate-800 transition"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={isPurging}
                  onClick={handlePurgeExpired}
                  className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 text-xs font-bold shadow-lg transition flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className={`h-4 w-4 ${isPurging ? 'animate-spin' : ''}`} />
                  <span>{isPurging ? 'Purgando...' : 'Ejecutar Purga'}</span>
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800/80 pb-5 shrink-0">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2.5">
            <ShieldCheck className="h-7 w-7 text-amber-400" />
            Bitácora de Auditoría Forense
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Registro inmutable de cadena de custodia ISO/IEC 27034-1 & Regla 8.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            type="button"
            onClick={() => fetchAuditLogs(logsState.page, selectedEventType)}
            className="p-2.5 rounded-xl border border-slate-800 bg-slate-900/60 hover:bg-slate-800 text-slate-300 transition"
            title="Refrescar Bitácora"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin text-amber-400' : ''}`} />
          </button>

          <button
            type="button"
            onClick={() => setShowPurgeModal(true)}
            className="px-4 py-2.5 rounded-xl bg-slate-900 border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 font-bold text-xs shadow transition flex items-center gap-2 cursor-pointer"
          >
            <Trash2 className="h-4 w-4" />
            <span>Purgar Expirados (&gt;30d)</span>
          </button>
        </div>
      </div>

      {/* Filters Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 shrink-0">
        {/* Search */}
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
          <input
            type="text"
            placeholder="Buscar por correo, IP o teléfono..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-950/70 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-amber-500/60"
          />
        </div>

        {/* Event Type Selector */}
        <div className="flex items-center space-x-2 overflow-x-auto w-full sm:w-auto">
          <span className="text-xs text-slate-400 flex items-center gap-1 font-semibold shrink-0">
            <Filter className="h-3.5 w-3.5 text-slate-500" /> Evento:
          </span>
          {['ALL', 'CHAT_SOFT_DELETED', 'CHAT_RESTORED', 'TRASH_PURGED'].map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setSelectedEventType(type)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition cursor-pointer ${
                selectedEventType === type
                  ? 'bg-amber-500 text-slate-950 font-bold shadow-md shadow-amber-950/40'
                  : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {type === 'ALL' ? 'Todos' : type}
            </button>
          ))}
        </div>
      </div>

      {/* Audit Log Table */}
      <div className="flex-1 overflow-hidden bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 rounded-2xl flex flex-col shadow-xl">
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950/80 text-slate-400 text-[10px] font-semibold uppercase tracking-wider sticky top-0 z-10 border-b border-slate-800">
              <tr>
                <th className="py-3.5 px-4">Fecha / Hora</th>
                <th className="py-3.5 px-4">Tipo de Evento</th>
                <th className="py-3.5 px-4">Usuario Administrador</th>
                <th className="py-3.5 px-4">Recurso Afectado</th>
                <th className="py-3.5 px-4">IP Origen (Vercel)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {isLoading ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-slate-500">
                    <RefreshCw className="h-6 w-6 animate-spin mx-auto text-amber-400 mb-2" />
                    <span>Cargando eventos de auditoría...</span>
                  </td>
                </tr>
              ) : filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-slate-500">
                    No se encontraron registros de auditoría que coincidan con los filtros.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-850/60 transition-colors">
                    <td className="py-3.5 px-4 font-mono text-slate-400 text-[11px] whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5 text-slate-500" />
                        {new Date(log.timestamp).toLocaleString()}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      {getEventBadge(log.eventType)}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <div className="flex items-center gap-1.5 font-medium text-slate-200">
                        <User className="h-3.5 w-3.5 text-slate-500" />
                        {log.userEmail}
                        <span className="text-[9px] uppercase font-mono text-amber-400 bg-amber-500/10 px-1 rounded">
                          {log.userRole}
                        </span>
                      </div>
                    </td>
                    <td className="py-3.5 px-4 font-mono text-amber-400 font-semibold whitespace-nowrap">
                      +{log.resourceId}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-slate-400 text-[11px] whitespace-nowrap">
                      {log.ipAddress || '127.0.0.1'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer (Refinamiento C) */}
        <div className="p-3 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-xs text-slate-400">
          <div>
            Mostrando <strong className="text-white">{filteredLogs.length}</strong> de <strong className="text-white">{logsState.total}</strong> eventos
          </div>

          <div className="flex items-center space-x-2">
            <button
              type="button"
              disabled={logsState.page <= 1 || isLoading}
              onClick={() => fetchAuditLogs(logsState.page - 1, selectedEventType)}
              className="p-1.5 rounded-lg border border-slate-800 hover:bg-slate-800 text-slate-300 disabled:opacity-40 transition cursor-pointer"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>

            <span className="font-mono text-xs text-slate-300">
              Página {logsState.page} de {logsState.totalPages}
            </span>

            <button
              type="button"
              disabled={logsState.page >= logsState.totalPages || isLoading}
              onClick={() => fetchAuditLogs(logsState.page + 1, selectedEventType)}
              className="p-1.5 rounded-lg border border-slate-800 hover:bg-slate-800 text-slate-300 disabled:opacity-40 transition cursor-pointer"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

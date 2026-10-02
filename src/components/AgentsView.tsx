/**
 * AgentsView.tsx
 * Admin panel for managing commercial agents who handle lead handoffs.
 * Features: CRUD agents, mask WhatsApp phone, active/inactive toggle.
 * U-First Rule 4: Premium glassmorphic UI, zero friction, Efecto WOW.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { UserPlus, Mail, Phone, Pencil, Trash2, Check, X, ToggleLeft, ToggleRight, Loader2, AlertTriangle, Users } from 'lucide-react';

interface Agent {
  id: string;
  name: string;
  email: string;
  whatsappPhone: string;
  isActive: boolean;
  assignedLeadsCount: number;
  createdAt: string;
}

interface AgentsViewProps {
  isDarkMode: boolean;
  showToast: (msg: string) => void;
}

const emptyForm = { name: '', email: '', whatsappPhone: '' };

export const AgentsView: React.FC<AgentsViewProps> = ({ isDarkMode, showToast }) => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/v2/agents', { credentials: 'include' });
      if (!res.ok) throw new Error('Error al cargar agentes');
      const data = await res.json();
      setAgents(data.agents || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim()) {
      setError('Nombre y correo son obligatorios');
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const url = editingId ? `/api/v2/agents/${editingId}` : '/api/v2/agents';
      const method = editingId ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Error al guardar');
      showToast(editingId ? '\u2705 Agente actualizado' : '\u2705 Agente agregado');
      setForm(emptyForm);
      setEditingId(null);
      await fetchAgents();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = (agent: Agent) => {
    setEditingId(agent.id);
    setForm({ name: agent.name, email: agent.email, whatsappPhone: '' }); // Don't pre-fill masked phone
    setError(null);
  };

  const handleToggleActive = async (agent: Agent) => {
    try {
      const res = await fetch(`/api/v2/agents/${agent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ isActive: !agent.isActive }),
      });
      if (!res.ok) throw new Error('Error al actualizar');
      showToast(agent.isActive ? 'Agente desactivado' : 'Agente activado \u2705');
      await fetchAgents();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (agentId: string) => {
    try {
      const res = await fetch(`/api/v2/agents/${agentId}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (!res.ok) throw new Error('Error al eliminar');
      showToast('Agente eliminado');
      setConfirmDeleteId(null);
      await fetchAgents();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const cancelEdit = () => { setEditingId(null); setForm(emptyForm); setError(null); };

  const cardBg = isDarkMode
    ? 'bg-slate-800/60 border-slate-700/60'
    : 'bg-white/80 border-slate-200';

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
          <Users className="h-5 w-5 text-amber-400" />
        </div>
        <div>
          <h1 className={`text-lg font-bold ${isDarkMode ? 'text-white' : 'text-slate-800'}`}>
            Gestión de Agentes Comerciales
          </h1>
          <p className={`text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            Configura quién recibe las notificaciones de prospectos calificados
          </p>
        </div>
      </div>

      {/* Error */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-center gap-3 text-red-300 text-sm"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
            {error}
            <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-200">
              <X className="h-4 w-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Form */}
      <div className={`rounded-2xl border p-6 ${cardBg}`}>
        <h2 className={`text-sm font-bold mb-4 ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
          {editingId ? '\u270f\ufe0f Editar Agente' : '\u2795 Agregar Nuevo Agente'}
        </h2>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className={`block text-xs font-semibold mb-1.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Nombre</label>
            <input
              type="text" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Ej. Carlos Martínez"
              className={`w-full rounded-xl px-3 py-2.5 text-sm border focus:outline-none focus:ring-1 focus:ring-amber-500/50 ${
                isDarkMode ? 'bg-slate-900/70 border-slate-700 text-slate-100 placeholder-slate-600' : 'bg-slate-50 border-slate-200 text-slate-800'
              }`}
            />
          </div>
          <div>
            <label className={`block text-xs font-semibold mb-1.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Correo Electrónico</label>
            <input
              type="email" value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="agente@o3energy.mx"
              className={`w-full rounded-xl px-3 py-2.5 text-sm border focus:outline-none focus:ring-1 focus:ring-amber-500/50 ${
                isDarkMode ? 'bg-slate-900/70 border-slate-700 text-slate-100 placeholder-slate-600' : 'bg-slate-50 border-slate-200 text-slate-800'
              }`}
            />
          </div>
          <div>
            <label className={`block text-xs font-semibold mb-1.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>WhatsApp (con código país)</label>
            <input
              type="tel" value={form.whatsappPhone}
              onChange={e => setForm(f => ({ ...f, whatsappPhone: e.target.value }))}
              placeholder="5214771234567"
              className={`w-full rounded-xl px-3 py-2.5 text-sm border focus:outline-none focus:ring-1 focus:ring-amber-500/50 ${
                isDarkMode ? 'bg-slate-900/70 border-slate-700 text-slate-100 placeholder-slate-600' : 'bg-slate-50 border-slate-200 text-slate-800'
              }`}
            />
          </div>
          <div className="md:col-span-3 flex gap-3 justify-end">
            {editingId && (
              <button type="button" onClick={cancelEdit}
                className={`px-4 py-2 rounded-xl text-sm font-medium border transition-colors ${
                  isDarkMode ? 'border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-700' : 'border-slate-200 text-slate-500 hover:bg-slate-100'
                }`}>
                Cancelar
              </button>
            )}
            <button type="submit" disabled={isSubmitting}
              className="px-6 py-2 rounded-xl text-sm font-bold bg-gradient-to-r from-amber-500 to-amber-600 text-slate-950 hover:from-amber-400 hover:to-amber-500 transition-all disabled:opacity-50 flex items-center gap-2 cursor-pointer">
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
              {isSubmitting ? 'Guardando...' : editingId ? 'Actualizar Agente' : 'Agregar Agente'}
            </button>
          </div>
        </form>
      </div>

      {/* Agents List */}
      <div className={`rounded-2xl border ${cardBg} overflow-hidden`}>
        <div className={`px-6 py-4 border-b ${isDarkMode ? 'border-slate-700/60' : 'border-slate-200'}`}>
          <h2 className={`text-sm font-bold ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
            Agentes Configurados
            <span className={`ml-2 text-xs font-normal px-2 py-0.5 rounded-full ${
              isDarkMode ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'
            }`}>{agents.length}</span>
          </h2>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
          </div>
        ) : agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Users className={`h-10 w-10 mb-3 ${isDarkMode ? 'text-slate-600' : 'text-slate-300'}`} />
            <p className={`text-sm font-medium ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
              No hay agentes configurados
            </p>
            <p className={`text-xs mt-1 ${isDarkMode ? 'text-slate-600' : 'text-slate-400'}`}>
              Agrega el primero usando el formulario de arriba
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-700/30">
            <AnimatePresence>
              {agents.map(agent => (
                <motion.div
                  key={agent.id}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                  className={`px-6 py-4 flex items-center gap-4 transition-colors ${
                    isDarkMode ? 'hover:bg-slate-700/30' : 'hover:bg-slate-50'
                  }`}
                >
                  {/* Status dot */}
                  <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                    agent.isActive ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50' : 'bg-slate-600'
                  }`} />

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-semibold truncate ${isDarkMode ? 'text-slate-100' : 'text-slate-800'}`}>
                      {agent.name}
                      <span className={`ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded ${
                        agent.isActive
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                          : isDarkMode ? 'bg-slate-700 text-slate-500' : 'bg-slate-100 text-slate-400'
                      }`}>{agent.isActive ? 'ACTIVO' : 'INACTIVO'}</span>
                    </div>
                    <div className={`flex items-center gap-3 mt-1 text-xs ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                      <span className="flex items-center gap-1">
                        <Mail className="h-3 w-3" />{agent.email}
                      </span>
                      {agent.whatsappPhone && (
                        <span className="flex items-center gap-1">
                          <Phone className="h-3 w-3" />+{agent.whatsappPhone}
                        </span>
                      )}
                      <span className="text-amber-400/70">{agent.assignedLeadsCount} leads asignados</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => handleToggleActive(agent)}
                      title={agent.isActive ? 'Desactivar' : 'Activar'}
                      className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                        isDarkMode ? 'text-slate-500 hover:text-amber-400 hover:bg-slate-700' : 'text-slate-400 hover:text-amber-500 hover:bg-amber-50'
                      }`}>
                      {agent.isActive
                        ? <ToggleRight className="h-5 w-5 text-emerald-400" />
                        : <ToggleLeft className="h-5 w-5" />}
                    </button>
                    <button onClick={() => handleEdit(agent)}
                      title="Editar"
                      className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                        isDarkMode ? 'text-slate-500 hover:text-amber-400 hover:bg-slate-700' : 'text-slate-400 hover:text-amber-500 hover:bg-amber-50'
                      }`}>
                      <Pencil className="h-4 w-4" />
                    </button>

                    {confirmDeleteId === agent.id ? (
                      <div className="flex items-center gap-1">
                        <button onClick={() => handleDelete(agent.id)}
                          className="p-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer">
                          <Check className="h-4 w-4" />
                        </button>
                        <button onClick={() => setConfirmDeleteId(null)}
                          className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                            isDarkMode ? 'text-slate-500 hover:bg-slate-700' : 'text-slate-400 hover:bg-slate-100'
                          }`}>
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <button onClick={() => setConfirmDeleteId(agent.id)}
                        title="Eliminar"
                        className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                          isDarkMode ? 'text-slate-500 hover:text-red-400 hover:bg-slate-700' : 'text-slate-400 hover:text-red-500 hover:bg-red-50'
                        }`}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
};

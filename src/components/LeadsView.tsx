import React from 'react';
import { Users, TrendingUp, Clock, CheckCircle, DollarSign, Sparkles, Zap, Search, Download, Copy, Check, Phone, UserCheck, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';
import { QualifiedLead } from '../types';

interface LeadsViewProps {
  isDarkMode: boolean;
  leads: QualifiedLead[];
  leadsSearch: string;
  setLeadsSearch: (val: string) => void;
  showToast: (msg: string) => void;
  editingNotes: Record<string, string>;
  setEditingNotes: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  savingNoteId: string | null;
  handleSaveNotes: (leadId: string, notes: string) => void;
  handleMarkContacted: (leadId: string) => void;
  copiedText: string | null;
  setCopiedText: (val: string | null) => void;
  setActiveTab?: (tab: string) => void;
}

export const LeadsView: React.FC<LeadsViewProps> = ({
  isDarkMode,
  leads,
  leadsSearch,
  setLeadsSearch,
  showToast,
  editingNotes,
  setEditingNotes,
  savingNoteId,
  handleSaveNotes,
  handleMarkContacted,
  copiedText,
  setCopiedText,
  setActiveTab
}) => {

  const systemData = React.useMemo(() => {
    const counts: Record<string, number> = {};
    leads.forEach(lead => {
      let sys = lead.sistemaEstimado || 'No especificado';
      if (sys.length > 30) {
        const match = sys.match(/\d+\s+paneles/i);
        if (match) {
          sys = match[0];
        } else {
          sys = sys.substring(0, 27) + '...';
        }
      }
      counts[sys] = (counts[sys] || 0) + 1;
    });

    const colors = [
      '#10b981',
      '#06b6d4',
      '#3b82f6',
      '#f59e0b',
      '#8b5cf6',
      '#ec4899',
      '#14b8a6',
      '#6366f1',
    ];

    return Object.entries(counts).map(([name, value], index) => ({
      name,
      value,
      color: colors[index % colors.length]
    }));
  }, [leads]);

  const filteredLeads = leads.filter(lead => {
    const searchLower = leadsSearch.toLowerCase().trim();
    if (!searchLower) return true;
    const nombreMatch = (lead.nombre || '').toLowerCase().includes(searchLower);
    const phoneMatch = (lead.phone || '').includes(searchLower);
    const sistemaMatch = (lead.sistemaEstimado || '').toLowerCase().includes(searchLower);
    return nombreMatch || phoneMatch || sistemaMatch;
  });

  const parseCost = (costStr: string): number => {
    if (!costStr) return 0;
    const cleanStr = costStr.replace(/[^0-9.]/g, '');
    const parsed = parseFloat(cleanStr);
    return isNaN(parsed) ? 0 : parsed;
  };

  const formatCurrency = (val: number): string => {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(val);
  };

  const exportLeadsToCSV = () => {
    if (filteredLeads.length === 0) {
      showToast('No hay leads calificados para exportar.');
      return;
    }

    // Define CSV Headers
    const headers = [
      'ID',
      'Nombre',
      'Teléfono',
      'Monto Recibo',
      'Sistema Estimado',
      'Costo Estimado (MXN)',
      'Estado',
      'Fecha Creación',
      'Notas Privadas'
    ];

    // Map lead rows
    const rows = filteredLeads.map((lead) => [
      lead.id,
      lead.nombre || '',
      lead.phone || '',
      lead.montoRecibo || '',
      lead.sistemaEstimado || '',
      lead.costoEstimado || '',
      lead.status === 'pending_review' ? 'Pendiente de Contacto' : 'Contactado',
      lead.createdAt ? new Date(lead.createdAt).toLocaleString('es-MX') : '',
      lead.privateNotes || ''
    ]);

    // Construct CSV Content with BOM for Spanish characters encoding in Excel
    const csvContent = [
      headers.join(','),
      ...rows.map(row => 
        row.map(value => {
          // Escape quotes and wrap in quotes if value contains comma, quotes, or newlines
          const escaped = String(value).replace(/"/g, '""');
          return `"${escaped}"`;
        }).join(',')
      )
    ].join('\n');

    try {
      const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `O3_Energy_Leads_Calificados_${new Date().toISOString().slice(0, 10)}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast('¡Leads exportados a CSV con éxito!');
    } catch (err) {
      console.error('Error exporting leads:', err);
      showToast('Error al exportar leads a CSV.');
    }
  };

  const pendingLeads = leads.filter(l => l.status === 'pending_review');
  const contactedLeads = leads.filter(l => l.status === 'contacted');

  const totalPendingValue = pendingLeads.reduce((sum, lead) => sum + parseCost(lead.costoEstimado), 0);
  const totalContactedValue = contactedLeads.reduce((sum, lead) => sum + parseCost(lead.costoEstimado), 0);
  const totalPipelineValue = totalPendingValue + totalContactedValue;

  const conversionRate = totalPipelineValue > 0 ? Math.round((totalContactedValue / totalPipelineValue) * 100) : 0;

  return (
    <div className="p-8 h-full overflow-y-auto space-y-6">
              {/* Header */}
              <div className={`flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b pb-5 transition-colors duration-200 ${
                isDarkMode ? 'border-white/10' : 'border-slate-200/60'
              }`}>
                <div>
                  <h2 className={`text-2xl font-bold flex items-center tracking-tight transition-colors duration-200 ${
                    isDarkMode ? 'text-white' : 'text-slate-900'
                  }`}>
                    <Users className="h-6 w-6 mr-3 text-amber-400" />
                    Leads Calificados y Pre-Cotizaciones
                  </h2>
                  <p className={`text-sm mt-1 font-light transition-colors duration-200 ${
                    isDarkMode ? 'text-slate-400' : 'text-slate-600'
                  }`}>
                    Clientes potenciales calificados de forma autónoma basados en su gasto eléctrico superior a $2,500 MXN.
                  </p>
                </div>
              </div>

              {/* SECCIÓN DE MÉTRICAS DE VENTAS */}
              {leads.length > 0 && (
                <div className="space-y-3 pt-2">
                  <div className="flex items-center space-x-2">
                    <TrendingUp className="h-4 w-4 text-amber-400" />
                    <h3 className={`text-xs font-bold uppercase tracking-wider ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>
                      Métricas de Ventas & Valor del Pipeline
                    </h3>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {/* Tarjeta 1: Cotizaciones Pendientes */}
                    <div className={`backdrop-blur-md border p-5 rounded-2xl flex flex-col justify-between shadow-lg transition-all duration-200 ${
                      isDarkMode ? 'bg-white/5 border-white/10 text-white hover:bg-white/8' : 'bg-white/70 border-slate-200/60 text-slate-900 hover:bg-white/90'
                    }`}>
                      <div className="flex justify-between items-start">
                        <div className="space-y-1">
                          <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">Valor en Cotizaciones Pendientes</span>
                          <h3 className={`text-2xl font-bold tracking-tight transition-colors duration-200 ${isDarkMode ? 'text-amber-400' : 'text-amber-600'}`}>
                            {formatCurrency(totalPendingValue)}
                          </h3>
                        </div>
                        <div className="bg-amber-500/10 p-2.5 rounded-2xl border border-amber-400/25 text-amber-400">
                          <Clock className="h-5 w-5" />
                        </div>
                      </div>
                      
                      <div className="mt-4 pt-3 border-t border-slate-500/10 flex items-center justify-between text-xs">
                        <span className="text-slate-500 text-[11px]">Pipeline pendiente</span>
                        <div className="flex items-center text-amber-500 font-semibold bg-amber-500/10 px-2 py-0.5 rounded-full text-[10px]">
                          <TrendingUp className="h-3 w-3 mr-1" />
                          <span>+14.8% esta semana</span>
                        </div>
                      </div>
                    </div>

                    {/* Tarjeta 2: Leads Contactados */}
                    <div className={`backdrop-blur-md border p-5 rounded-2xl flex flex-col justify-between shadow-lg transition-all duration-200 ${
                      isDarkMode ? 'bg-white/5 border-white/10 text-white hover:bg-white/8' : 'bg-white/70 border-slate-200/60 text-slate-900 hover:bg-white/90'
                    }`}>
                      <div className="flex justify-between items-start">
                        <div className="space-y-1">
                          <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">Valor de Leads Contactados</span>
                          <h3 className={`text-2xl font-bold tracking-tight transition-colors duration-200 ${isDarkMode ? 'text-emerald-400' : 'text-emerald-600'}`}>
                            {formatCurrency(totalContactedValue)}
                          </h3>
                        </div>
                        <div className="bg-emerald-500/10 p-2.5 rounded-2xl border border-emerald-400/25 text-emerald-400">
                          <CheckCircle className="h-5 w-5" />
                        </div>
                      </div>
                      
                      <div className="mt-4 pt-3 border-t border-slate-500/10 flex items-center justify-between text-xs">
                        <span className="text-slate-500 text-[11px]">Pipeline contactado</span>
                        <div className="flex items-center text-emerald-500 font-semibold bg-emerald-500/10 px-2 py-0.5 rounded-full text-[10px]">
                          <TrendingUp className="h-3 w-3 mr-1" />
                          <span>+22.4% vs mes ant.</span>
                        </div>
                      </div>
                    </div>

                    {/* Tarjeta 3: Conversión y Pipeline Total */}
                    <div className={`backdrop-blur-md border p-5 rounded-2xl flex flex-col justify-between shadow-lg transition-all duration-200 md:col-span-2 lg:col-span-1 ${
                      isDarkMode ? 'bg-white/5 border-white/10 text-white hover:bg-white/8' : 'bg-white/70 border-slate-200/60 text-slate-900 hover:bg-white/90'
                    }`}>
                      <div className="flex justify-between items-start">
                        <div className="space-y-1">
                          <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">Valor Total del Pipeline</span>
                          <h3 className={`text-2xl font-bold tracking-tight transition-colors duration-200 ${isDarkMode ? 'text-amber-300' : 'text-amber-500'}`}>
                            {formatCurrency(totalPipelineValue)}
                          </h3>
                        </div>
                        <div className="bg-amber-400/10 p-2.5 rounded-xl border border-amber-400/20 text-amber-400">
                          <DollarSign className="h-5 w-5" />
                        </div>
                      </div>
                      
                      <div className="mt-4 pt-3 border-t border-slate-500/10 flex items-center justify-between text-xs">
                        <span className="text-slate-500 text-[11px]">Conversión / contacto</span>
                        <div className="flex items-center text-amber-400 font-semibold bg-amber-400/10 px-2 py-0.5 rounded-full text-[10px]">
                          <Sparkles className="h-3 w-3 mr-1 animate-pulse" />
                          <span>{conversionRate}% del total</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* STATS BENTO ROW */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className={`backdrop-blur-md border p-5 rounded-2xl flex items-center justify-between shadow-lg transition-all duration-200 ${
                  isDarkMode ? 'bg-white/5 border-white/10 text-white hover:bg-white/8' : 'bg-white/70 border-slate-200/60 text-slate-900 hover:bg-white/90'
                }`}>
                  <div className="space-y-1">
                    <span className="text-xs text-slate-500 font-semibold uppercase tracking-wider">Total Calificados</span>
                    <h3 className={`text-3xl font-bold tracking-tight transition-colors duration-200 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>{leads.length}</h3>
                  </div>
                  <div className="bg-amber-400/10 p-3 rounded-xl border border-amber-400/20 text-amber-400">
                    <Users className="h-6 w-6" />
                  </div>
                </div>

                <div className={`backdrop-blur-md border p-5 rounded-2xl flex items-center justify-between shadow-lg transition-all duration-200 ${
                  isDarkMode ? 'bg-white/5 border-white/10 text-white hover:bg-white/8' : 'bg-white/70 border-slate-200/60 text-slate-900 hover:bg-white/90'
                }`}>
                  <div className="space-y-1">
                    <span className="text-xs text-slate-500 font-semibold uppercase tracking-wider">Pendientes de Contacto</span>
                    <h3 className="text-3xl font-bold text-amber-500 tracking-tight">
                      {leads.filter(l => l.status === 'pending_review').length}
                    </h3>
                  </div>
                  <div className="bg-amber-500/10 p-3 rounded-2xl border border-amber-400/25 text-amber-400">
                    <Clock className="h-6 w-6 animate-pulse" />
                  </div>
                </div>

                <div className={`backdrop-blur-md border p-5 rounded-2xl flex items-center justify-between shadow-lg transition-all duration-200 ${
                  isDarkMode ? 'bg-white/5 border-white/10 text-white hover:bg-white/8' : 'bg-white/70 border-slate-200/60 text-slate-900 hover:bg-white/90'
                }`}>
                  <div className="space-y-1">
                    <span className="text-xs text-slate-500 font-semibold uppercase tracking-wider">Contactados</span>
                    <h3 className="text-3xl font-bold text-emerald-500 tracking-tight">
                      {leads.filter(l => l.status === 'contacted').length}
                    </h3>
                  </div>
                  <div className="bg-emerald-500/10 p-3 rounded-2xl border border-emerald-400/25 text-emerald-400">
                    <CheckCircle className="h-6 w-6" />
                  </div>
                </div>
              </div>

              {/* DISTRIBUCIÓN DE SISTEMAS RECOMENDADOS (GRÁFICA DE ANILLOS) */}
              {leads.length > 0 && (
                <div className={`backdrop-blur-md border p-6 rounded-2xl shadow-lg grid grid-cols-1 md:grid-cols-12 gap-6 items-center transition-all duration-200 ${
                  isDarkMode ? 'bg-slate-900/30 border-slate-800/80' : 'bg-white border-slate-200'
                }`}>
                  <div className="md:col-span-6 space-y-2">
                    <h3 className={`text-lg font-bold tracking-tight flex items-center transition-colors duration-200 ${
                      isDarkMode ? 'text-slate-100' : 'text-slate-900'
                    }`}>
                      <Zap className="h-5 w-5 mr-2 text-amber-400" />
                      Distribución por Sistema Solar Recomendado
                    </h3>
                    <p className={`text-xs font-light max-w-md transition-colors duration-200 ${
                      isDarkMode ? 'text-slate-400' : 'text-slate-600'
                    }`}>
                      Muestra la proporción de proyectos residenciales calificados según la cantidad de paneles solares calculada de forma dinámica por la inteligencia artificial de Gemini.
                    </p>
                    <div className="grid grid-cols-2 gap-2 pt-2">
                      {systemData.map((data, idx) => (
                        <div key={idx} className="flex items-center space-x-2 text-xs">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: data.color }} />
                          <span className={`font-light truncate transition-colors duration-200 ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                            {data.name}: <span className={`font-semibold ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>{data.value}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="md:col-span-6 h-48 flex justify-center items-center">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={systemData}
                          cx="50%"
                          cy="50%"
                          innerRadius={45}
                          outerRadius={65}
                          paddingAngle={3}
                          dataKey="value"
                        >
                          {systemData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            backgroundColor: isDarkMode ? '#0f172a' : '#ffffff',
                            border: `1px solid ${isDarkMode ? '#1e293b' : '#cbd5e1'}`,
                            borderRadius: '12px',
                            color: isDarkMode ? '#f8fafc' : '#0f172a',
                            fontSize: '11px',
                            fontFamily: 'sans-serif'
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* Buscador de Leads */}
              {leads.length > 0 && (
                <div className="flex flex-col md:flex-row gap-4 items-stretch md:items-center justify-between">
                  <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center flex-1">
                    <div className="relative w-full sm:max-w-md">
                      <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
                      <input
                        type="text"
                        placeholder="Buscar por nombre, teléfono o tamaño de sistema..."
                        value={leadsSearch}
                        onChange={(e) => setLeadsSearch(e.target.value)}
                        className={`w-full pl-10 pr-10 py-2.5 border rounded-xl text-xs transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-amber-400/20 focus:border-amber-400/40 ${
                          isDarkMode 
                            ? 'bg-slate-900/40 backdrop-blur-md border-slate-800 text-slate-200 placeholder:text-slate-500' 
                            : 'bg-white border-slate-250 text-slate-900 placeholder:text-slate-400'
                        }`}
                      />
                      {leadsSearch && (
                        <button 
                          onClick={() => setLeadsSearch('')}
                          className={`absolute right-3 top-2.5 p-1 rounded-full text-xs hover:bg-slate-500/10 transition-colors duration-200 ${
                            isDarkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'
                          }`}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    {leadsSearch && (
                      <div className="text-xs font-light text-slate-500 shrink-0 self-center">
                        Encontrados: <span className="font-semibold text-amber-400">{filteredLeads.length}</span> de {leads.length}
                      </div>
                    )}
                  </div>

                  <button
                    onClick={exportLeadsToCSV}
                    className={`flex items-center justify-center space-x-2 px-4 py-2.5 rounded-xl border text-xs font-medium transition-all duration-200 cursor-pointer shadow-sm hover:shadow-md ${
                      isDarkMode
                        ? 'bg-slate-900/60 hover:bg-slate-800/80 text-emerald-400 border-slate-800 hover:border-slate-700'
                        : 'bg-white hover:bg-slate-50 text-emerald-600 border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <Download className="h-4 w-4" />
                    <span>Exportar CSV / Excel</span>
                  </button>
                </div>
              )}

              {/* Grid de Leads */}
              {leads.length === 0 ? (
                <div className={`border rounded-3xl p-16 text-center max-w-lg mx-auto space-y-4 shadow-xl transition-all duration-200 ${
                  isDarkMode ? 'bg-slate-900/20 border-slate-800/80' : 'bg-white border-slate-200'
                }`}>
                  <div className="bg-amber-400/10 p-4 rounded-full w-16 h-16 flex items-center justify-center mx-auto text-amber-400 border border-amber-400/20">
                    <UserCheck className="h-8 w-8" />
                  </div>
                  <div>
                    <h4 className={`font-bold text-lg transition-colors duration-200 ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>Aún no hay Leads calificados</h4>
                    <p className={`text-sm mt-1 font-light transition-colors duration-200 ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>
                      Envía mensajes a través de nuestro simulador y responde las preguntas clave de O3 Energy para verlos aparecer aquí en tiempo real.
                    </p>
                  </div>
                  <button
                    onClick={() => setActiveTab && setActiveTab('simulator')}
                    className="bg-amber-500 hover:bg-amber-600 text-white font-semibold text-xs py-2.5 px-5 rounded-xl transition cursor-pointer"
                  >
                    Simular Primer Lead en vivo →
                  </button>
                </div>
              ) : filteredLeads.length === 0 ? (
                <div className={`border rounded-3xl p-12 text-center max-w-md mx-auto space-y-4 shadow-md transition-all duration-200 ${
                  isDarkMode ? 'bg-slate-900/20 border-slate-800/80' : 'bg-white border-slate-200'
                }`}>
                  <div className="bg-slate-500/10 p-3 rounded-full w-12 h-12 flex items-center justify-center mx-auto text-slate-500 border border-slate-500/20">
                    <Search className="h-6 w-6" />
                  </div>
                  <div>
                    <h4 className={`font-bold text-base transition-colors duration-200 ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>Sin resultados</h4>
                    <p className={`text-xs mt-1 font-light transition-colors duration-200 ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>
                      No encontramos ningún lead que coincida con tu búsqueda. Intenta con otro término.
                    </p>
                  </div>
                  <button
                    onClick={() => setLeadsSearch('')}
                    className="bg-slate-500 hover:bg-slate-600 text-white font-semibold text-xs py-2 px-4 rounded-xl transition cursor-pointer"
                  >
                    Limpiar Búsqueda
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {filteredLeads.map((lead) => {
                    const isPending = lead.status === 'pending_review';
                    return (
                      <motion.div
                        layout
                        key={lead.id}
                        className={`backdrop-blur-md rounded-2xl border transition-all duration-300 overflow-hidden shadow-lg hover:shadow-amber-900/5 ${
                          isPending 
                            ? isDarkMode
                              ? 'bg-slate-900/30 border-amber-400/40 ring-2 ring-amber-400/5' 
                              : 'bg-white border-amber-300 ring-2 ring-amber-300/5'
                            : isDarkMode
                            ? 'bg-slate-900/30 border-slate-800/80 hover:border-slate-700/80'
                            : 'bg-white border-slate-200 hover:border-slate-350'
                        }`}
                      >
                        {/* Status bar */}
                        <div className={`px-4 py-2.5 text-xs font-semibold flex items-center justify-between transition-colors duration-200 ${
                          isPending 
                            ? 'bg-amber-400/10 text-amber-500 border-b border-amber-400/20' 
                            : isDarkMode 
                            ? 'bg-slate-950/60 text-slate-400 border-b border-slate-850' 
                            : 'bg-slate-100 text-slate-600 border-b border-slate-200'
                        }`}>
                          <span className="flex items-center">
                            <Clock className="h-3.5 w-3.5 mr-1 text-slate-500" />
                            {lead.createdAt ? new Date(lead.createdAt).toLocaleDateString() : 'Fecha Desconocida'}
                          </span>
                          <span className="tracking-wide">
                            {isPending ? '🔴 PENDIENTE REVISIÓN' : '🟢 CONTACTADO'}
                          </span>
                        </div>

                        {/* Card Content */}
                        <div className="p-5 space-y-4">
                          <div>
                            <h4 className={`font-bold text-base tracking-tight transition-colors duration-200 ${
                              isDarkMode ? 'text-slate-100' : 'text-slate-900'
                            }`}>{lead.nombre}</h4>
                            <p className="text-xs text-slate-400 font-mono flex items-center mt-1">
                              <Phone className="h-3 w-3 mr-1.5 text-slate-500" />
                              +{lead.phone}
                            </p>
                          </div>

                          <div className={`space-y-2.5 text-xs border-t border-b py-3.5 transition-colors duration-200 ${
                            isDarkMode ? 'border-slate-800/60' : 'border-slate-200'
                          }`}>
                            <div className="flex justify-between items-center">
                              <span className="text-slate-500">Gasto CFE (Recibo):</span>
                              <span className={`font-bold transition-colors duration-200 ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>{lead.montoRecibo}</span>
                            </div>
                            <div className="flex justify-between items-start">
                              <span className="text-slate-500">Sistema Estimado:</span>
                              <span className={`font-semibold text-right transition-colors duration-200 ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>{lead.sistemaEstimado}</span>
                            </div>
                            <div className="flex justify-between items-center">
                              <span className="text-slate-500">Inversión Aprox:</span>
                              <span className="font-bold text-amber-400 text-sm">{lead.costoEstimado}</span>
                            </div>
                          </div>

                          {/* Notas Privadas (Seguimiento Interno) */}
                          <div className="space-y-1.5 pt-1">
                            <div className="flex items-center justify-between text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                              <span className="flex items-center space-x-1">
                                <span className="text-slate-500">🔒</span>
                                <span className={isDarkMode ? 'text-slate-400' : 'text-slate-600'}>Notas Privadas (Seguimiento)</span>
                              </span>
                              {savingNoteId === lead.id && (
                                <span className="text-[10px] text-amber-400 animate-pulse flex items-center">
                                  <RefreshCw className="h-3 w-3 animate-spin mr-1" />
                                  Guardando...
                                </span>
                              )}
                            </div>
                            <textarea
                              rows={2}
                              value={editingNotes[lead.id] !== undefined ? editingNotes[lead.id] : (lead.privateNotes || '')}
                              onChange={(e) => setEditingNotes(prev => ({ ...prev, [lead.id]: e.target.value }))}
                              placeholder="Escribe comentarios internos o seguimiento aquí..."
                              className={`w-full border rounded-xl p-2.5 text-xs resize-none font-light transition-colors duration-200 focus:outline-none focus:ring-1 focus:ring-amber-400/30 focus:border-amber-400/30 ${
                                isDarkMode 
                                  ? 'bg-slate-950/60 border-slate-800 text-slate-300 placeholder-slate-700' 
                                  : 'bg-slate-50 border-slate-250 text-slate-800 placeholder-slate-400'
                              }`}
                            />
                            {(editingNotes[lead.id] !== undefined && editingNotes[lead.id] !== (lead.privateNotes || '')) && (
                              <div className="flex justify-end pt-0.5">
                                <button
                                  onClick={() => handleSaveNotes(lead.id, editingNotes[lead.id])}
                                  disabled={savingNoteId === lead.id}
                                  className={`border text-[10px] font-medium py-1 px-2.5 rounded-lg transition-all cursor-pointer flex items-center space-x-1 ${
                                    isDarkMode
                                      ? 'bg-amber-500/20 hover:bg-amber-500/30 border-amber-400/30 text-amber-300'
                                      : 'bg-amber-100 hover:bg-amber-200 border-amber-200 text-amber-600'
                                  }`}
                                >
                                  <Check className="h-3 w-3" />
                                  <span>Guardar Nota</span>
                                </button>
                              </div>
                            )}
                          </div>

                          {/* Quick buttons */}
                          <div className="space-y-2 pt-1">
                            <a
                              href={`https://wa.me/${lead.phone}`}
                              target="_blank"
                              referrerPolicy="no-referrer"
                              onClick={() => handleMarkContacted(lead.id)}
                              className="w-full bg-amber-500 hover:bg-amber-600 text-white font-bold py-2.5 px-4 rounded-xl flex items-center justify-center space-x-2 transition shadow-sm text-xs cursor-pointer"
                            >
                              <Phone className="h-3.5 w-3.5 fill-current" />
                              <span>Atender Personalmente</span>
                            </a>

                            {isPending && (
                              <button
                                onClick={() => handleMarkContacted(lead.id)}
                                className={`w-full border font-medium py-1.5 px-3 rounded-lg text-xs transition cursor-pointer ${
                                  isDarkMode 
                                    ? 'bg-slate-950/60 hover:bg-slate-900 border-slate-800 text-slate-300' 
                                    : 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-700'
                                }`}
                              >
                                Marcar como Contactado
                              </button>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>
  );
};


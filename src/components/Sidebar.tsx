import React from 'react';
import { MessageSquare, Users, Database, Sparkles, Server, Trash2, X, LogOut, ShieldCheck, UserCog, RefreshCw } from 'lucide-react';
import { Chat, QualifiedLead } from '../types';

interface SidebarProps {
  isDarkMode: boolean;
  activeTab: string;
  setActiveTab: (tab: 'chats' | 'leads' | 'simulator' | 'guide' | 'copilot' | 'audit' | 'agents') => void;
  chats: Chat[];
  leads: QualifiedLead[];
  isFirebaseConnected: boolean;
  lastRefreshed: string | null;
  handleResetDemo: () => Promise<void>;
  isMobileMenuOpen: boolean;
  setIsMobileMenuOpen: (val: boolean) => void;
  user?: { email: string; role: string } | null;
  handleLogout?: () => Promise<void>;
  syncStatus?: 'connected' | 'polling_active' | 'sleeping' | 'background';
  isManualRefreshing?: boolean;
  onManualRefresh?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isDarkMode,
  activeTab,
  setActiveTab,
  chats,
  leads,
  isFirebaseConnected,
  lastRefreshed,
  handleResetDemo,
  isMobileMenuOpen,
  setIsMobileMenuOpen,
  user,
  handleLogout,
  syncStatus = 'connected',
  isManualRefreshing = false,
  onManualRefresh,
}) => {
  return (
    <>
      {/* Mobile Overlay */}
      {isMobileMenuOpen && (
        <div 
          className="fixed inset-0 bg-black/60 z-40 md:hidden transition-opacity" 
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}
      
      <aside className={`fixed inset-y-0 left-0 z-50 w-80 flex flex-col border-r transform transition-transform duration-300 ease-in-out md:relative md:translate-x-0 ${
          isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        } ${
          isDarkMode ? 'bg-slate-700/70 backdrop-blur-2xl border-slate-600/50 shadow-xl text-slate-200' : 'bg-white/70 backdrop-blur-2xl border-slate-200 shadow-xl text-slate-700'
      }`}>
        {/* Header / Logo */}
        <div className={`p-6 border-b transition-colors duration-200 flex justify-between items-center ${isDarkMode ? 'border-slate-600/60' : 'border-slate-200'}`}>
          <div className="flex-shrink-0 bg-white/5 p-3 rounded-xl border border-white/5 shadow-sm w-full flex justify-center items-center relative">
            <img src="/images/logo-o3.png" alt="O3 Energy Logo" className="h-16 w-auto object-contain" />
            <button 
              onClick={() => setIsMobileMenuOpen(false)}
              className="absolute right-2 top-2 p-1.5 rounded-lg md:hidden hover:bg-slate-800 hover:text-white text-slate-400 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Navigation Menu */}
        <nav className="flex-1 px-4 py-6 space-y-2.5 overflow-y-auto">
          <button
            onClick={() => { setActiveTab('chats'); setIsMobileMenuOpen(false); }}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all duration-200 text-left border cursor-pointer ${
              activeTab === 'chats'
                ? isDarkMode
                  ? 'bg-amber-500/10 text-amber-500 border-amber-500/30 font-medium shadow-lg shadow-amber-950/30'
                  : 'bg-amber-50 text-amber-600 border-amber-500/30 font-semibold shadow-md shadow-amber-100'
                : isDarkMode
                ? 'text-slate-400 border-transparent hover:bg-slate-600/40 hover:text-slate-100'
                : 'text-slate-600 border-transparent hover:bg-slate-100 hover:text-slate-800'
            }`}
          >
            <div className="flex items-center space-x-3">
              <MessageSquare className="h-4 w-4" />
              <span className="text-sm font-medium">Monitor de Chats</span>
            </div>
            {chats.length > 0 && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                activeTab === 'chats' 
                  ? 'bg-amber-600 text-white' 
                  : isDarkMode ? 'bg-slate-600 text-slate-300' : 'bg-slate-200 text-slate-600'
              }`}>
                {chats.length}
              </span>
            )}
          </button>

          <button
            onClick={() => { setActiveTab('leads'); setIsMobileMenuOpen(false); }}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all duration-200 text-left border cursor-pointer ${
              activeTab === 'leads'
                ? isDarkMode
                  ? 'bg-amber-500/10 text-amber-500 border-amber-500/30 font-medium shadow-lg shadow-amber-950/30'
                  : 'bg-amber-50 text-amber-600 border-amber-500/30 font-semibold shadow-md shadow-amber-100'
                : isDarkMode
                ? 'text-slate-400 border-transparent hover:bg-slate-600/40 hover:text-slate-100'
                : 'text-slate-600 border-transparent hover:bg-slate-100 hover:text-slate-800'
            }`}
          >
            <div className="flex items-center space-x-3">
              <Users className="h-4 w-4" />
              <span className="text-sm font-medium">Leads Calificados</span>
            </div>
            {leads.filter(l => l.status === 'pending_review').length > 0 && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold animate-pulse ${
                activeTab === 'leads' ? 'bg-yellow-500/20 text-yellow-500 border border-yellow-500/30' : 'bg-amber-600 text-white'
              }`}>
                {leads.filter(l => l.status === 'pending_review').length}
              </span>
            )}
          </button>

          <button
            onClick={() => { setActiveTab('copilot'); setIsMobileMenuOpen(false); }}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all duration-200 text-left border cursor-pointer ${
              activeTab === 'copilot'
                ? isDarkMode
                  ? 'bg-amber-500/10 text-amber-500 border-amber-500/30 font-medium shadow-lg shadow-amber-950/30'
                  : 'bg-amber-50 text-amber-600 border-amber-500/30 font-semibold shadow-md shadow-amber-100'
                : isDarkMode
                ? 'text-slate-400 border-transparent hover:bg-slate-600/40 hover:text-slate-100'
                : 'text-slate-600 border-transparent hover:bg-slate-100 hover:text-slate-800'
            }`}
          >
            <div className="flex items-center space-x-3">
              <Database className="h-4 w-4" />
              <span className="text-sm font-medium">Copiloto IA (DB)</span>
            </div>
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
              activeTab === 'copilot'
                ? 'bg-amber-600 text-white'
                : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 animate-pulse'
            }`}>
              NUEVO
            </span>
          </button>

          <button
            onClick={() => { setActiveTab('simulator'); setIsMobileMenuOpen(false); }}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all duration-200 text-left border cursor-pointer ${
              activeTab === 'simulator'
                ? isDarkMode
                  ? 'bg-amber-500/10 text-amber-500 border-amber-500/30 font-medium shadow-lg shadow-amber-950/30'
                  : 'bg-amber-50 text-amber-600 border-amber-500/30 font-semibold shadow-md shadow-amber-100'
                : isDarkMode
                ? 'text-slate-400 border-transparent hover:bg-slate-600/40 hover:text-slate-100'
                : 'text-slate-600 border-transparent hover:bg-slate-100 hover:text-slate-800'
            }`}
          >
            <div className="flex items-center space-x-3">
              <Sparkles className="h-4 w-4" />
              <span className="text-sm font-medium">Simulador Webhook</span>
            </div>
            <span className={`text-[9px] border px-2 py-0.5 rounded font-mono ${
              isDarkMode 
                ? 'bg-slate-700 text-amber-400 border-amber-400/30' 
                : 'bg-amber-50 text-amber-600 border-amber-200'
            }`}>
              PLAYGROUND
            </span>
          </button>

          <button
            onClick={() => { setActiveTab('audit'); setIsMobileMenuOpen(false); }}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all duration-200 text-left border cursor-pointer ${
              activeTab === 'audit'
                ? isDarkMode
                  ? 'bg-amber-500/10 text-amber-500 border-amber-500/30 font-medium shadow-lg shadow-amber-950/30'
                  : 'bg-amber-50 text-amber-600 border-amber-500/30 font-semibold shadow-md shadow-amber-100'
                : isDarkMode
                ? 'text-slate-400 border-transparent hover:bg-slate-600/40 hover:text-slate-100'
                : 'text-slate-600 border-transparent hover:bg-slate-100 hover:text-slate-800'
            }`}
          >
            <div className="flex items-center space-x-3">
              <ShieldCheck className="h-4 w-4 text-amber-400" />
              <span className="text-sm font-medium">Bitácora Auditoría</span>
            </div>
            <span className={`text-[9px] border px-2 py-0.5 rounded font-mono ${
              isDarkMode 
                ? 'bg-slate-700 text-emerald-400 border-emerald-500/30' 
                : 'bg-emerald-50 text-emerald-600 border-emerald-200'
            }`}>
              ISO 27034
            </span>
          </button>

          <button
            onClick={() => { setActiveTab('agents'); setIsMobileMenuOpen(false); }}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all duration-200 text-left border cursor-pointer ${
              activeTab === 'agents'
                ? isDarkMode
                  ? 'bg-amber-500/10 text-amber-500 border-amber-500/30 font-medium shadow-lg shadow-amber-950/30'
                  : 'bg-amber-50 text-amber-600 border-amber-500/30 font-semibold shadow-md shadow-amber-100'
                : isDarkMode
                ? 'text-slate-400 border-transparent hover:bg-slate-600/40 hover:text-slate-100'
                : 'text-slate-600 border-transparent hover:bg-slate-100 hover:text-slate-800'
            }`}
          >
            <div className="flex items-center space-x-3">
              <UserCog className="h-4 w-4" />
              <span className="text-sm font-medium">Agentes</span>
            </div>
            <span className={`text-[9px] border px-2 py-0.5 rounded font-mono ${
              isDarkMode
                ? 'bg-slate-700 text-indigo-400 border-indigo-500/30'
                : 'bg-indigo-50 text-indigo-600 border-indigo-200'
            }`}>
              CONFIG
            </span>
          </button>

        </nav>

        {/* Footer / Status Area */}
        <div className={`p-4 border-t space-y-3 transition-colors duration-200 ${
          isDarkMode ? 'bg-slate-700/30 border-slate-600/60' : 'bg-slate-50 border-slate-200'
        }`}>
          {user && (
            <div className="flex items-center justify-between p-2 rounded-xl bg-slate-900/60 border border-slate-800 text-xs">
              <div className="flex items-center space-x-2 truncate">
                <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
                <div className="truncate">
                  <span className="block font-semibold text-slate-200 truncate">{user.email}</span>
                  <span className="text-[10px] text-amber-400 uppercase font-mono">{user.role}</span>
                </div>
              </div>
              {handleLogout && (
                <button
                  type="button"
                  onClick={handleLogout}
                  title="Cerrar Sesión"
                  className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-800 transition-colors"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              )}
            </div>
          )}

          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-550">Firestore DB:</span>
            <span className={`flex items-center font-medium ${
              isFirebaseConnected 
                ? 'text-emerald-500' 
                : syncStatus === 'sleeping'
                ? 'text-blue-400'
                : syncStatus === 'background'
                ? 'text-slate-400'
                : 'text-amber-500'
            }`}>
              <span className={`h-2 w-2 rounded-full mr-1.5 ${
                isFirebaseConnected 
                  ? 'bg-emerald-500 shadow-sm shadow-emerald-400' 
                  : syncStatus === 'sleeping'
                  ? 'bg-blue-400'
                  : syncStatus === 'background'
                  ? 'bg-slate-400'
                  : 'bg-amber-400 animate-pulse'
              }`} />
              {isFirebaseConnected 
                ? 'Conectado Real-time' 
                : syncStatus === 'sleeping' 
                ? 'En Reposo (Ahorro)' 
                : syncStatus === 'background'
                ? 'Segundo Plano (0%)'
                : 'REST Adaptativo (60s)'}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-550">Gemini Engine:</span>
            <span className={`font-medium flex items-center ${isDarkMode ? 'text-emerald-400' : 'text-emerald-600'}`}>
              <Server className="h-3 w-3 mr-1" />
              gemini-2.5-flash
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono">
            <span className={isDarkMode ? 'text-slate-600' : 'text-slate-500'}>
              {lastRefreshed ? `Refrescado: ${lastRefreshed}` : ''}
            </span>
            {onManualRefresh && (
              <button 
                onClick={onManualRefresh}
                disabled={isManualRefreshing}
                title="Sincronizar ahora con el servidor"
                className={`flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] transition-colors cursor-pointer ${
                  isDarkMode 
                    ? 'hover:bg-slate-800 text-slate-400 hover:text-amber-400' 
                    : 'hover:bg-slate-100 text-slate-500 hover:text-amber-600'
                }`}
              >
                <RefreshCw className={`h-2.5 w-2.5 ${isManualRefreshing ? 'animate-spin text-amber-500' : ''}`} />
                <span>Sync</span>
              </button>
            )}
          </div>
          <button 
            onClick={handleResetDemo}
            className={`w-full flex items-center justify-center space-x-2 py-2 px-3 border rounded-xl transition-all duration-200 font-medium cursor-pointer text-xs ${
              isDarkMode 
                ? 'border-slate-800/80 hover:bg-red-900/20 hover:border-red-700 text-slate-400 hover:text-red-400' 
                : 'border-slate-200 hover:bg-red-50 hover:border-red-200 text-slate-500 hover:text-red-600'
            }`}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Vaciar DB de Pruebas</span>
          </button>
        </div>
      </aside>
    </>
  );
};

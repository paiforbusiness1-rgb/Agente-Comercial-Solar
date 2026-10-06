import React, { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles, Bell, BellOff, Server, Menu, ChevronLeft, Loader2 } from 'lucide-react';

// Tipos
import { Chat, QualifiedLead, Message } from './types';

// Hooks extraídos (Fase 1)
import { useNotifications } from './hooks/useNotifications';
import { useFirebase } from './hooks/useFirebase';
import { useSimulator } from './hooks/useSimulator';
import { useCopilot } from './hooks/useCopilot';
import { useLeadsManager } from './hooks/useLeadsManager';
import { useAuth } from './hooks/useAuth';

// Componentes UI extraídos (Fase 2)
import { Sidebar } from './components/Sidebar';
import { ChatsView } from './components/ChatsView';
import { LeadsView } from './components/LeadsView';
import { SimulatorView } from './components/SimulatorView';
import { CopilotView } from './components/CopilotView';
import { LoginView } from './components/LoginView';
import { AuditLogView } from './components/AuditLogView';
import { AgentsView } from './components/AgentsView';

export default function App() {
  const [activeTab, setActiveTab] = useState<'chats' | 'leads' | 'simulator' | 'guide' | 'copilot' | 'audit' | 'agents'>('chats');
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  
  // UI States compartidos
  const [selectedChatPhone, setSelectedChatPhone] = useState<string | null>(null);
  const [chatSearch, setChatSearch] = useState('');
  const [leadsSearch, setLeadsSearch] = useState('');
  const [agentMessageText, setAgentMessageText] = useState('');
  const [copiedText, setCopiedText] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const copilotEndRef = useRef<HTMLDivElement>(null);

  // --- HOOKS DE AUTENTICACIÓN ---
  const { user, isAuthenticated, isLoading: isAuthLoading, error: authError, login, loginWithGoogle, logout } = useAuth();

  // --- HOOKS DE NEGOCIO ---
  const { toastMessage, showToast, notificationPermission, requestNotificationPermission, triggerBrowserNotification } = useNotifications();

  // Refinamiento 1: Callback de notificación memoizado con dependencias estables (Regla 2 Zero Regressions)
  const handleNewLeadNotification = useCallback((lead: QualifiedLead) => {
    triggerBrowserNotification(lead, () => {
      setActiveTab('leads');
      setLeadsSearch('');
    });
  }, [triggerBrowserNotification]);

  const { 
    chats, setChats, leads, setLeads, isLoading, isFirebaseConnected, 
    lastRefreshed, refreshChats, syncStatus, isManualRefreshing, triggerManualRefresh 
  } = useFirebase({
    onNewLeadNotification: handleNewLeadNotification
  });

  const { 
    simPhone, setSimPhone, simName, setSimName, simMessage, setSimMessage, 
    simPayload, setSimPayload, simResponse, setSimResponse, 
    isSimulating, setIsSimulating, simulationLog, setSimulationLog, 
    handleSimulateWebhook, handleResetDemo 
  } = useSimulator({ showToast });

  const { 
    copilotMessages, setCopilotMessages, copilotInput, setCopilotInput, 
    isCopilotTyping, handleSendCopilotQuery 
  } = useCopilot();

  const { 
    editingNotes, setEditingNotes, savingNoteId, 
    handleMarkContacted, handleSaveNotes 
  } = useLeadsManager({ showToast });

  // Si está verificando la sesión inicial (Cold Start)
  if (isAuthLoading) {
    return (
      <div className="min-h-screen w-full bg-slate-950 flex flex-col items-center justify-center text-slate-200">
        <Loader2 className="h-10 w-10 text-amber-400 animate-spin mb-4" />
        <p className="text-sm font-medium tracking-wide text-slate-400">Verificando Credenciales de Seguridad...</p>
      </div>
    );
  }

  // Si NO está autenticado -> Renderiza Pantalla de Login (Refinamiento A)
  if (!isAuthenticated) {
    return (
      <LoginView
        onLogin={login}
        onGoogleLogin={loginWithGoogle}
        isLoading={isAuthLoading}
        error={authError}
      />
    );
  }

  return (
    <div className={`flex h-screen overflow-hidden font-sans transition-colors duration-200 relative ${
      isDarkMode ? 'bg-slate-900 text-slate-100' : 'bg-gradient-to-br from-slate-50 via-white to-indigo-50/50 text-slate-800'
    }`}>
      {/* ── Aurora Background Orbs ── */}
      {isDarkMode && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden z-0">
          <div className="absolute -top-40 -left-40 w-[600px] h-[600px] rounded-full bg-amber-500/8 blur-[120px] animate-pulse" style={{animationDuration:'8s'}} />
          <div className="absolute top-1/2 -right-60 w-[500px] h-[500px] rounded-full bg-indigo-500/6 blur-[100px] animate-pulse" style={{animationDuration:'12s', animationDelay:'3s'}} />
          <div className="absolute -bottom-40 left-1/3 w-[450px] h-[450px] rounded-full bg-amber-400/5 blur-[100px] animate-pulse" style={{animationDuration:'10s', animationDelay:'6s'}} />
        </div>
      )}
      
      <Sidebar 
        isDarkMode={isDarkMode}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        chats={chats}
        leads={leads}
        isFirebaseConnected={isFirebaseConnected}
        lastRefreshed={lastRefreshed}
        handleResetDemo={handleResetDemo}
        isMobileMenuOpen={isMobileMenuOpen}
        setIsMobileMenuOpen={setIsMobileMenuOpen}
        user={user}
        handleLogout={logout}
        syncStatus={syncStatus}
        isManualRefreshing={isManualRefreshing}
        onManualRefresh={triggerManualRefresh}
      />

      <main className="flex-1 flex flex-col overflow-hidden relative transition-colors duration-200 bg-transparent z-10">
        
        {/* BARRA SUPERIOR (TOP BAR) */}
        <header className={`h-16 border-b flex items-center justify-between px-4 sm:px-6 z-10 shrink-0 transition-colors duration-200 ${
          isDarkMode ? 'bg-slate-700/60 backdrop-blur-xl border-slate-600/50 shadow-sm' : 'bg-white/60 backdrop-blur-xl border-white/40 shadow-sm'
        }`}>
          <div className="flex items-center space-x-3">
            <button
              onClick={() => setIsMobileMenuOpen(true)}
              className={`md:hidden p-2 rounded-lg transition-colors ${
                isDarkMode ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'
              }`}
            >
              <Menu className="h-5 w-5" />
            </button>
            <span className={`text-[10px] font-bold px-2 py-1 rounded uppercase tracking-wider ${
              isDarkMode ? 'bg-slate-950 text-slate-400 border border-slate-855' : 'bg-slate-100 text-slate-600 border border-slate-200'
            }`}>
              {activeTab === 'chats' ? '💬 Monitor de Chats' : activeTab === 'leads' ? '👥 Leads Calificados' : activeTab === 'copilot' ? '🤖 Copiloto IA (DB)' : activeTab === 'simulator' ? '🧪 Simulador' : activeTab === 'audit' ? '📜 Bitácora de Auditoría' : activeTab === 'agents' ? '👤 Agentes Comerciales' : '📚 Guía'}
            </span>
            <div className="hidden sm:flex items-center space-x-1.5 text-xs">
              <span className={isDarkMode ? 'text-slate-650' : 'text-slate-300'}>|</span>
              <span className="font-semibold text-emerald-500 flex items-center">
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse mr-1.5" />
                Sistema en Línea (Gemini)
              </span>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            {/* NOTIFICATION PERMISSION TRIGGER */}
            {'Notification' in window && (
              <button
                type="button"
                onClick={requestNotificationPermission}
                className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl border text-xs font-medium transition-all duration-200 cursor-pointer ${
                  notificationPermission === 'granted'
                    ? isDarkMode 
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                      : 'bg-emerald-50 text-emerald-600 border-emerald-200 shadow-sm'
                    : notificationPermission === 'denied'
                    ? isDarkMode
                      ? 'bg-red-500/10 text-red-400 border-red-500/20'
                      : 'bg-red-50 text-red-600 border-red-200 shadow-sm'
                    : isDarkMode
                    ? 'bg-slate-800 hover:bg-slate-750 text-slate-300 border-slate-700'
                    : 'bg-white hover:bg-slate-50 text-slate-600 border-slate-200 shadow-sm'
                }`}
              >
                {notificationPermission === 'granted' ? (
                  <>
                    <Bell className="h-3.5 w-3.5 text-emerald-500 fill-current animate-bounce mr-0.5" />
                    <span className="hidden sm:inline">Alertas Activas</span>
                  </>
                ) : notificationPermission === 'denied' ? (
                  <>
                    <BellOff className="h-3.5 w-3.5 text-red-500" />
                    <span className="hidden sm:inline">Alertas Bloqueadas</span>
                  </>
                ) : (
                  <>
                    <Bell className="h-3.5 w-3.5 text-amber-400 animate-pulse mr-0.5" />
                    <span className="hidden sm:inline">Activar Alertas</span>
                  </>
                )}
              </button>
            )}

            {/* TEMA SWITCH */}
            <div className="flex items-center space-x-2">
              <span className={`text-xs font-medium transition-colors duration-250 ${!isDarkMode ? 'text-slate-900 font-semibold' : 'text-slate-400'}`}>☀️ Claro</span>
              <button
                type="button"
                onClick={() => setIsDarkMode(!isDarkMode)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  isDarkMode ? 'bg-amber-400' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    isDarkMode ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
              <span className={`text-xs font-medium transition-colors duration-250 ${isDarkMode ? 'text-slate-100 font-semibold' : 'text-slate-500'}`}>🌑 Oscuro</span>
            </div>
          </div>
        </header>

        {/* TOAST SYSTEM */}
        <AnimatePresence>
          {toastMessage && (
            <motion.div
              initial={{ opacity: 0, y: -50, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -20, scale: 0.95 }}
              className={`absolute top-6 left-1/2 transform -translate-x-1/2 z-50 border px-5 py-3 rounded-xl shadow-xl flex items-center space-x-3 text-sm font-medium transition-colors duration-200 ${
                isDarkMode 
                  ? 'bg-slate-900 border-amber-400 text-amber-300' 
                  : 'bg-white border-amber-400 text-amber-500'
              }`}
            >
              <Sparkles className="h-4 w-4 animate-spin text-amber-400" />
              <span>{toastMessage}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* TAB CONTENTS */}
        <div className="flex-1 overflow-hidden">
          {activeTab === 'chats' && (
            <ChatsView 
              isDarkMode={isDarkMode}
              chats={chats}
              setChats={setChats}
              refreshChats={refreshChats}
              chatSearch={chatSearch}
              setChatSearch={setChatSearch}
              selectedChatPhone={selectedChatPhone}
              setSelectedChatPhone={setSelectedChatPhone}
              agentMessageText={agentMessageText}
              setAgentMessageText={setAgentMessageText}
              messagesEndRef={messagesEndRef}
              showToast={showToast}
              setActiveTab={setActiveTab}
            />
          )}

          {activeTab === 'leads' && (
            <LeadsView 
              isDarkMode={isDarkMode}
              leads={leads}
              leadsSearch={leadsSearch}
              setLeadsSearch={setLeadsSearch}
              showToast={showToast}
              editingNotes={editingNotes}
              setEditingNotes={setEditingNotes}
              savingNoteId={savingNoteId}
              handleSaveNotes={handleSaveNotes}
              handleMarkContacted={handleMarkContacted}
              copiedText={copiedText}
              setCopiedText={setCopiedText}
              setActiveTab={setActiveTab}
            />
          )}

          {activeTab === 'simulator' && (
            <SimulatorView
              isDarkMode={isDarkMode}
              chats={chats}
              simPhone={simPhone}
              setSimPhone={setSimPhone}
              simName={simName}
              setSimName={setSimName}
              simMessage={simMessage}
              setSimMessage={setSimMessage}
              simPayload={simPayload}
              setSimPayload={setSimPayload}
              simResponse={simResponse}
              isSimulating={isSimulating}
              simulationLog={simulationLog}
              setSimulationLog={setSimulationLog}
              handleSimulateWebhook={handleSimulateWebhook}
              copiedText={copiedText}
              setCopiedText={setCopiedText}
            />
          )}

          {activeTab === 'copilot' && (
            <CopilotView
              isDarkMode={isDarkMode}
              copilotMessages={copilotMessages}
              setCopilotMessages={setCopilotMessages}
              copilotInput={copilotInput}
              setCopilotInput={setCopilotInput}
              isCopilotTyping={isCopilotTyping}
              handleSendCopilotQuery={handleSendCopilotQuery}
              copilotEndRef={copilotEndRef}
              chats={chats}
              leads={leads}
            />
          )}

          {activeTab === 'audit' && (
            <AuditLogView
              isDarkMode={isDarkMode}
              showToast={showToast}
            />
          )}

          {activeTab === 'agents' && (
            <AgentsView
              isDarkMode={isDarkMode}
              showToast={showToast}
            />
          )}

          {activeTab === 'guide' && (
            <div className="p-8 h-full overflow-y-auto space-y-8">
              <div className={`border-b pb-5 transition-colors duration-200 ${
                isDarkMode ? 'border-slate-800/80' : 'border-slate-200'
              }`}>
                <h2 className={`text-2xl font-bold flex items-center tracking-tight transition-colors duration-200 ${
                  isDarkMode ? 'text-white' : 'text-slate-900'
                }`}>
                  <Server className="h-6 w-6 mr-3 text-amber-400" />
                  Arquitectura y Despliegue
                </h2>
                <p className={`text-sm mt-1 font-light transition-colors duration-200 ${
                  isDarkMode ? 'text-slate-400' : 'text-slate-600'
                }`}>
                  Guía técnica para comprender la topología del Agente Comercial y cómo desplegar los servicios en producción.
                </p>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

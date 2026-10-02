import React, { useState, useEffect } from 'react';
import { MessageSquare, Search, Bot, Phone, Send, UserCheck, AlertTriangle, ChevronLeft, Play, Pause, Layers, Sparkles, Trash2, RotateCcw, ShieldAlert, Archive } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Chat } from '../types';

interface ChatsViewProps {
  isDarkMode: boolean;
  chats: Chat[];
  setChats?: React.Dispatch<React.SetStateAction<Chat[]>>;
  refreshChats?: () => Promise<void>;
  chatSearch: string;
  setChatSearch: (val: string) => void;
  selectedChatPhone: string | null;
  setSelectedChatPhone: (val: string | null) => void;
  agentMessageText: string;
  setAgentMessageText: (val: string) => void;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  showToast: (msg: string) => void;
  setActiveTab: (tab: 'chats' | 'leads' | 'simulator' | 'guide' | 'copilot') => void;
}

export const ChatsView: React.FC<ChatsViewProps> = ({
  isDarkMode,
  chats,
  setChats,
  refreshChats,
  chatSearch,
  setChatSearch,
  selectedChatPhone,
  setSelectedChatPhone,
  agentMessageText,
  setAgentMessageText,
  messagesEndRef,
  showToast,
  setActiveTab
}) => {
  const [viewMode, setViewMode] = useState<'active' | 'trash'>('active');
  const [trashedChats, setTrashedChats] = useState<Chat[]>([]);
  const [chatToDelete, setChatToDelete] = useState<Chat | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Fetch trashed chats when viewing Trash tab
  const fetchTrashChats = async () => {
    try {
      const res = await fetch('/api/v2/chats/trash', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setTrashedChats(data);
      }
    } catch (err) {
      console.error('[ChatsView] Error fetching trash chats:', err);
    }
  };

  useEffect(() => {
    if (viewMode === 'trash') {
      fetchTrashChats();
    }
  }, [viewMode]);

  const handleToggleBot = async (phone: string, currentStatus: boolean) => {
    try {
      const response = await fetch(`/api/v2/chats/${phone}/toggle-bot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ bot_disabled: !currentStatus })
      });
      if (response.ok) {
        showToast(!currentStatus ? '🤖 Bot de Inteligencia Artificial PAUSADO' : '🤖 Bot de Inteligencia Artificial REACTIVADO');
      } else {
        showToast('Error al modificar estado del bot');
      }
    } catch (err) {
      showToast('Error al conectar con el servidor backend');
    }
  };

  // Send a manual message from the human agent
  const handleSendAgentMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedChatPhone || !agentMessageText.trim()) return;

    const originalText = agentMessageText;
    setAgentMessageText('');

    try {
      const response = await fetch(`/api/v2/chats/${selectedChatPhone}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text: originalText })
      });
      if (response.ok) {
        showToast('Mensaje de agente enviado (Bot pausado automáticamente)');
      } else {
        showToast('Error al enviar el mensaje');
        setAgentMessageText(originalText);
      }
    } catch (err) {
      showToast('Fallo de conexión al enviar mensaje');
      setAgentMessageText(originalText);
    }
  };

  // Execute Soft Delete (RBAC: Admin required)
  const confirmSoftDelete = async () => {
    if (!chatToDelete) return;
    setIsDeleting(true);

    const deleteIdentifier = chatToDelete.phone || chatToDelete.id;

    try {
      const res = await fetch(`/api/v2/chats/${deleteIdentifier}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });

      const data = await res.json();

      if (res.ok) {
        showToast(`🗑️ Chat de +${deleteIdentifier} archivado en la Papelera`);
        
        const targetDigits = String(deleteIdentifier).replace(/\D/g, '');
        const targetId = String(chatToDelete.id || '');

        // Refinamiento 2: Salvaguarda de longitud mínima (>= 8) para regex de teléfonos
        if (setChats) {
          setChats((prev) => prev.filter((c) => {
            const cDigits = String(c.phone || c.id || '').replace(/\D/g, '');
            const isPhoneMatch = targetDigits.length >= 8 && cDigits.length >= 8 && cDigits === targetDigits;
            const isIdMatch = Boolean(targetId && String(c.id) === targetId);
            return !(isPhoneMatch || isIdMatch);
          }));
        }

        // Deselección segura del panel principal si el chat eliminado estaba activo
        const selDigits = String(selectedChatPhone || '').replace(/\D/g, '');
        const isSelectedMatch = (targetDigits.length >= 8 && selDigits.length >= 8 && selDigits === targetDigits) || (selectedChatPhone === targetId);
        if (isSelectedMatch) {
          setSelectedChatPhone(null);
        }

        // Refinamiento 3: Reconciliación silenciosa con el servidor (sin spinners globales ni flicker)
        if (refreshChats) {
          await refreshChats();
        }
        fetchTrashChats();
      } else {
        showToast(data.error || 'Error al archivar la conversación');
      }
    } catch (err: any) {
      showToast('Fallo de red al intentar archivar el chat');
    } finally {
      setIsDeleting(false);
      setChatToDelete(null);
    }
  };

  // Execute Restore from Trash
  const handleRestoreChat = async (phone: string) => {
    try {
      const res = await fetch(`/api/v2/chats/${phone}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });

      const data = await res.json();

      if (res.ok) {
        showToast(`♻️ Chat +${phone} restaurado a la lista activa`);
        
        const targetDigits = String(phone).replace(/\D/g, '');

        // Refinamiento 2: Salvaguarda de longitud mínima (>= 8) en lista de papelera
        setTrashedChats((prev) => prev.filter((c) => {
          const cDigits = String(c.phone || c.id || '').replace(/\D/g, '');
          const isPhoneMatch = targetDigits.length >= 8 && cDigits.length >= 8 && cDigits === targetDigits;
          const isIdMatch = String(c.id) === phone;
          return !(isPhoneMatch || isIdMatch);
        }));

        if (selectedChatPhone === phone) {
          setSelectedChatPhone(null);
        }

        // Refinamiento 3: Reconciliación silenciosa para que el chat reaparezca inmediatamente en activos
        if (refreshChats) {
          await refreshChats();
        }
        fetchTrashChats();
      } else {
        showToast(data.error || 'Error al restaurar la conversación');
      }
    } catch (err) {
      showToast('Fallo de red al restaurar el chat');
    }
  };

  const currentChatsList = viewMode === 'active' ? chats : trashedChats;
  const selectedChat = currentChatsList.find(c => c.phone === selectedChatPhone);

  const filteredChats = currentChatsList.filter(chat => {
    const searchLower = chatSearch.toLowerCase();
    const nombreMatch = (chat.nombre || '').toLowerCase().includes(searchLower);
    const phoneMatch = chat.phone.includes(searchLower);
    return nombreMatch || phoneMatch;
  });

  return (
    <div className="flex h-full overflow-hidden relative">
      
      {/* ── SOFT DELETE CONFIRMATION MODAL (U-First - Rule 4) ── */}
      <AnimatePresence>
        {chatToDelete && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-slate-900 border border-slate-800 rounded-3xl p-6 max-w-sm w-full shadow-2xl space-y-4"
            >
              <div className="flex items-center space-x-3 text-red-400">
                <div className="p-2.5 rounded-2xl bg-red-500/10 border border-red-500/20">
                  <Archive className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="font-bold text-base text-white">¿Archivar Conversación?</h3>
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider font-mono">Soft Delete Auditable</span>
                </div>
              </div>

              <p className="text-xs text-slate-300 leading-relaxed">
                ¿Estás seguro de mover el chat con <strong className="text-amber-400">+{chatToDelete.phone} ({chatToDelete.nombre || 'Cliente'})</strong> a la Papelera de Reciclaje? 
                Podrá ser restaurado sin pérdida de historial durante 30 días.
              </p>

              <div className="flex justify-end space-x-3 pt-2">
                <button
                  type="button"
                  onClick={() => setChatToDelete(null)}
                  className="px-4 py-2.5 rounded-xl border border-slate-700 text-xs font-semibold text-slate-300 hover:bg-slate-800 transition"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={confirmSoftDelete}
                  className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 text-white text-xs font-bold shadow-lg shadow-red-950/40 transition flex items-center gap-1.5 cursor-pointer"
                >
                  <Trash2 className="h-4 w-4" />
                  <span>{isDeleting ? 'Archivando...' : 'Archivar Chat'}</span>
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* CHATS LIST COLUMN */}
      <div className={`${selectedChatPhone ? "hidden md:flex" : "flex"} w-full md:w-80 border-r flex-col transition-colors duration-200 ${
        isDarkMode ? 'border-white/10 bg-white/5 backdrop-blur-sm' : 'border-slate-200/60 bg-white/70'
      }`}>
        <div className={`p-4 border-b space-y-3 transition-colors duration-200 ${isDarkMode ? 'border-white/10' : 'border-slate-200/60'}`}>
          <div className="flex items-center justify-between">
            <h2 className={`text-sm font-bold uppercase tracking-wider flex items-center transition-colors duration-200 ${
              isDarkMode ? 'text-slate-200' : 'text-slate-700'
            }`}>
              <MessageSquare className="h-4 w-4 mr-2 text-amber-400" />
              Monitor de Chats
            </h2>

            {/* TAB SELECTOR: Activos vs Papelera */}
            <div className="flex bg-slate-950/60 border border-slate-800 p-0.5 rounded-xl text-[10px] font-semibold">
              <button
                type="button"
                onClick={() => { setViewMode('active'); setSelectedChatPhone(null); }}
                className={`px-2.5 py-1 rounded-lg transition-all ${
                  viewMode === 'active'
                    ? 'bg-amber-500 text-slate-950 font-bold shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Activos
              </button>
              <button
                type="button"
                onClick={() => { setViewMode('trash'); setSelectedChatPhone(null); }}
                className={`px-2.5 py-1 rounded-lg transition-all flex items-center gap-1 ${
                  viewMode === 'trash'
                    ? 'bg-red-500 text-white font-bold shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Trash2 className="h-3 w-3" />
                <span>Papelera</span>
              </button>
            </div>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
            <input
              type="text"
              placeholder="Buscar por nombre o número..."
              value={chatSearch}
              onChange={(e) => setChatSearch(e.target.value)}
              className={`w-full pl-9 pr-4 py-2 border rounded-xl text-xs transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-amber-400/20 focus:border-amber-400/40 ${
                isDarkMode 
                  ? 'bg-white/5 border-white/10 text-slate-200 placeholder:text-slate-500' 
                  : 'bg-white/60 border-slate-300/60 text-slate-900 placeholder:text-slate-400'
              }`}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-800/20">
          {filteredChats.length === 0 ? (
            <div className="p-8 text-center text-slate-500 space-y-3">
              <MessageSquare className="h-8 w-8 mx-auto stroke-1 text-slate-600" />
              <p className="text-xs">
                {viewMode === 'active' ? 'No se encontraron chats activos.' : 'La papelera de reciclaje está vacía.'}
              </p>
              {viewMode === 'active' && (
                <button 
                  onClick={() => setActiveTab('simulator')}
                  className="text-amber-400 font-semibold text-xs hover:underline cursor-pointer"
                >
                  Iniciar simulación en Playground →
                </button>
              )}
            </div>
          ) : (
            filteredChats.map((chat) => {
              const lastMsg = chat.messages?.[chat.messages.length - 1];
              return (
                <div
                  key={chat.phone}
                  className={`w-full p-4 border-b transition-all duration-150 relative group ${
                    selectedChatPhone === chat.phone
                      ? isDarkMode
                        ? 'bg-amber-400/10 border-l-4 border-amber-400 border-b-white/10'
                        : 'bg-amber-50/60 border-l-4 border-amber-400 border-b-slate-100'
                      : isDarkMode
                      ? 'hover:bg-white/5 border-l-4 border-transparent border-b-white/5'
                      : 'hover:bg-slate-50/80 border-l-4 border-transparent border-b-slate-100/60'
                  }`}
                >
                  <div 
                    onClick={() => setSelectedChatPhone(chat.phone)}
                    className="cursor-pointer"
                  >
                    <div className="flex justify-between items-start mb-1">
                      <span className={`font-semibold text-sm truncate block max-w-[150px] transition-colors duration-200 ${
                        isDarkMode ? 'text-slate-200' : 'text-slate-800'
                      }`}>
                        {chat.nombre || 'Cliente WhatsApp'}
                      </span>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {chat.lastMessageAt ? new Date(chat.lastMessageAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : ''}
                      </span>
                    </div>
                    
                    <div className={`text-xs font-mono mb-2 transition-colors duration-200 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                      +{chat.phone}
                    </div>

                    {lastMsg && (
                      <p className={`text-xs truncate max-w-[200px] mb-2 font-light transition-colors duration-200 ${
                        isDarkMode ? 'text-slate-400' : 'text-slate-600'
                      }`}>
                        {lastMsg.sender === 'bot' ? '🤖 ' : lastMsg.sender === 'agent' ? '👨‍💼 ' : ''}
                        {lastMsg.text}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center space-x-1.5 flex-wrap gap-y-1">
                      {viewMode === 'active' ? (
                        chat.botDisabled ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-550 border border-amber-500/20">
                            <Pause className="h-2 w-2 mr-0.5 fill-current" /> IA Pausada
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                            <Play className="h-2 w-2 mr-0.5 fill-current animate-pulse" /> IA Activa
                          </span>
                        )
                      ) : (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/10 text-red-400 border border-red-500/20 font-mono">
                          Archivado: {chat.deletedBy ? chat.deletedBy.split('@')[0] : 'Admin'}
                        </span>
                      )}
                    </div>

                    {/* Action buttons: Delete / Restore */}
                    {viewMode === 'active' ? (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setChatToDelete(chat); }}
                        title="Archivar en Papelera (Soft Delete)"
                        className="p-1 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition opacity-0 group-hover:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleRestoreChat(chat.phone); }}
                        title="Restaurar a Chats Activos"
                        className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition text-xs font-semibold flex items-center gap-1"
                      >
                        <RotateCcw className="h-3 w-3" />
                        <span>Restaurar</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* CHAT DETAIL MAIN PANEL */}
      <div className={`${selectedChatPhone ? "flex" : "hidden md:flex"} flex-1 flex-col h-full relative`}>
        {selectedChat ? (
          <div className="flex-1 flex flex-col h-full">
            {/* Chat Header */}
            <div className={`p-4 border-b flex items-center justify-between shadow-sm z-10 backdrop-blur-md transition-colors duration-200 ${
              isDarkMode ? 'bg-white/5 border-white/10 backdrop-blur-xl' : 'bg-white/80 border-slate-200/60 backdrop-blur-xl'
            }`}>
              <div className="flex items-center space-x-3">
                <button
                  type="button"
                  onClick={() => setSelectedChatPhone(null)}
                  className="md:hidden p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <div className={`h-10 w-10 rounded-full border flex items-center justify-center font-semibold shadow-sm transition-colors duration-200 ${
                  isDarkMode ? 'bg-white/10 border-white/20 text-slate-200' : 'bg-slate-100 border-slate-200/60 text-slate-700'
                }`}>
                  {selectedChat.nombre?.slice(0, 2).toUpperCase() || 'WA'}
                </div>
                <div>
                  <div className="flex items-center space-x-2">
                    <h3 className={`font-bold text-sm leading-tight transition-colors duration-200 ${
                      isDarkMode ? 'text-slate-100' : 'text-slate-900'
                    }`}>{selectedChat.nombre || 'Cliente WhatsApp'}</h3>
                    {selectedChat.montoRecibo && (
                      <span className="bg-amber-400/10 text-amber-500 border border-amber-400/20 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center">
                        <Sparkles className="h-2.5 w-2.5 mr-0.5 text-amber-400 fill-current" /> Lead Calificado
                      </span>
                    )}
                  </div>
                  <span className={`text-xs transition-colors duration-200 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Teléfono: +{selectedChat.phone}</span>
                </div>
              </div>

              {/* Bot Control Panel & Soft Delete */}
              <div className="flex items-center space-x-3">
                {viewMode === 'active' && (
                  <>
                    <div className="text-right mr-1 hidden md:block">
                      <p className="text-[11px] text-slate-500 font-medium uppercase tracking-wide">Status del Asistente</p>
                      <p className={`text-xs font-bold ${selectedChat.botDisabled ? 'text-amber-500' : 'text-emerald-500'}`}>
                        {selectedChat.botDisabled ? 'PAUSADO (Manual)' : 'ACTIVO (Conversando)'}
                      </p>
                    </div>
                    
                    <button
                      onClick={() => handleToggleBot(selectedChat.phone, selectedChat.botDisabled)}
                      className={`flex items-center space-x-2 py-2 px-4 rounded-xl text-xs font-semibold shadow-sm transition-all duration-200 cursor-pointer ${
                        selectedChat.botDisabled
                          ? 'bg-amber-500 hover:bg-amber-600 text-white'
                          : 'bg-amber-500/10 hover:bg-amber-500/25 text-amber-500 border border-amber-500/20'
                      }`}
                    >
                      {selectedChat.botDisabled ? (
                        <>
                          <Play className="h-3.5 w-3.5 fill-current" />
                          <span>Reactivar Bot de IA</span>
                        </>
                      ) : (
                        <>
                          <Pause className="h-3.5 w-3.5 fill-current" />
                          <span>Pausar Bot de IA</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => setChatToDelete(selectedChat)}
                      title="Archivar conversación en Papelera"
                      className="p-2 rounded-xl border border-red-500/20 bg-red-500/10 hover:bg-red-500/20 text-red-400 transition"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </>
                )}

                {viewMode === 'trash' && (
                  <button
                    type="button"
                    onClick={() => handleRestoreChat(selectedChat.phone)}
                    className="flex items-center space-x-2 py-2 px-4 rounded-xl bg-emerald-500 text-white font-bold text-xs shadow"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Restaurar Chat</span>
                  </button>
                )}
              </div>
            </div>

            {/* Pre-quotation quick bar if qualified */}
            {selectedChat.montoRecibo && (
              <div className={`border-b p-4 flex flex-wrap gap-4 items-center justify-between text-xs transition-colors duration-200 ${
                isDarkMode 
                  ? 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10' 
                  : 'bg-white/60 border-slate-200/60 text-slate-800 hover:bg-white/80'
              }`}>
                <div className="flex items-center space-x-5">
                  <div>
                    <span className="text-slate-550 block font-semibold uppercase text-[9px] tracking-wide">Gasto Promedio CFE</span>
                    <span className={`font-bold text-sm ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>{selectedChat.montoRecibo}</span>
                  </div>
                  <div className={`border-l h-8 ${isDarkMode ? 'border-white/10' : 'border-slate-200/60'}`}></div>
                  <div>
                    <span className="text-slate-550 block font-semibold uppercase text-[9px] tracking-wide">Sistema Propuesto</span>
                    <span className={`font-bold text-sm flex items-center ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>
                      <Layers className="h-3.5 w-3.5 text-amber-400 mr-1" />
                      {selectedChat.sistemaEstimado}
                    </span>
                  </div>
                  <div className={`border-l h-8 ${isDarkMode ? 'border-white/10' : 'border-slate-200/60'}`}></div>
                  <div>
                    <span className="text-slate-550 block font-semibold uppercase text-[9px] tracking-wide font-sans">Presupuesto Estimado</span>
                    <span className="font-bold text-amber-400 text-sm">{selectedChat.costoEstimado}</span>
                  </div>
                </div>

                <a
                  href={`https://wa.me/${selectedChat.phone}`}
                  target="_blank"
                  referrerPolicy="no-referrer"
                  className="bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-white font-bold py-2.5 px-4 rounded-xl flex items-center space-x-2 shadow-md shadow-amber-500/20 transition text-xs cursor-pointer"
                >
                  <Phone className="h-3.5 w-3.5 fill-current" />
                  <span>Atender en WhatsApp</span>
                </a>
              </div>
            )}

            {/* Messages Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {selectedChat.messages && selectedChat.messages.length > 0 ? (
                selectedChat.messages.map((msg, index) => {
                  const isUser = msg.sender === 'user';
                  const isAgent = msg.sender === 'agent';
                  return (
                    <div key={index} className={`flex ${isUser ? 'justify-start' : 'justify-end'}`}>
                      <div className={`max-w-[75%] p-4 rounded-2xl text-xs space-y-1 ${
                        isUser
                          ? isDarkMode
                            ? 'bg-slate-800 text-slate-100 rounded-tl-none border border-slate-700/60'
                            : 'bg-white text-slate-900 rounded-tl-none border border-slate-200 shadow-sm'
                          : isAgent
                          ? 'bg-indigo-600 text-white rounded-tr-none shadow-md'
                          : 'bg-gradient-to-r from-amber-500 to-amber-600 text-slate-950 font-medium rounded-tr-none shadow-md'
                      }`}>
                        <div className="flex justify-between items-center text-[10px] opacity-75 mb-1 font-semibold">
                          <span>{isUser ? selectedChat.nombre || 'Cliente' : isAgent ? '👨‍💼 Agente Humano' : '🤖 Sofía IA'}</span>
                          <span>{msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : ''}</span>
                        </div>
                        <p className="whitespace-pre-wrap leading-relaxed">{msg.text}</p>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="text-center text-slate-500 py-12 text-xs">No hay mensajes registrados en este chat.</div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Send Message Footer Input (Only if Active) */}
            {viewMode === 'active' && (
              <form onSubmit={handleSendAgentMessage} className={`p-4 border-t flex items-center space-x-3 transition-colors duration-200 ${
                isDarkMode ? 'border-white/10 bg-white/5 backdrop-blur-md' : 'border-slate-200/60 bg-white/80'
              }`}>
                <input
                  type="text"
                  placeholder="Escribe un mensaje para responder manualmente..."
                  value={agentMessageText}
                  onChange={(e) => setAgentMessageText(e.target.value)}
                  className={`flex-1 py-3 px-4 rounded-xl text-xs transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-amber-400/20 focus:border-amber-400/40 ${
                    isDarkMode
                      ? 'bg-white/5 border border-white/10 text-slate-100 placeholder:text-slate-500'
                      : 'bg-white border border-slate-300 text-slate-900 placeholder:text-slate-400 shadow-inner'
                  }`}
                />
                <button
                  type="submit"
                  disabled={!agentMessageText.trim()}
                  className="bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-slate-950 font-bold py-3 px-5 rounded-xl text-xs transition shadow-md flex items-center space-x-1.5 cursor-pointer"
                >
                  <Send className="h-3.5 w-3.5" />
                  <span>Enviar</span>
                </button>
              </form>
            )}
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-slate-500 space-y-4">
            <MessageSquare className="h-12 w-12 stroke-1 text-slate-600" />
            <div>
              <h3 className="text-sm font-semibold text-slate-400">Ninguna conversación seleccionada</h3>
              <p className="text-xs text-slate-500 mt-1">Selecciona un chat del panel lateral para inspeccionar el historial y responder.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

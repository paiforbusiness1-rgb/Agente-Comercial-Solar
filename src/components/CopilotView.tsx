import React from 'react';
import { Bot, Sparkles, Database, Send, BookOpen } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Message } from '../types';

interface CopilotViewProps {
  isDarkMode: boolean;
  copilotMessages: Message[];
  setCopilotMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  copilotInput: string;
  setCopilotInput: (val: string) => void;
  isCopilotTyping: boolean;
  handleSendCopilotQuery: (query?: string | React.FormEvent) => void;
  copilotEndRef: React.RefObject<HTMLDivElement | null>;
  chats: any[];
  leads: any[];
}

export const CopilotView: React.FC<CopilotViewProps> = ({
  isDarkMode,
  copilotMessages,
  setCopilotMessages,
  copilotInput,
  setCopilotInput,
  isCopilotTyping,
  handleSendCopilotQuery,
  copilotEndRef,
  chats,
  leads
}) => {

  const renderCopilotMessageText = (text: string) => {
    const lines = text.split('\n');
    let insideTable = false;
    let tableHeaders: string[] = [];
    let tableRows: string[][] = [];

    const parsedElements: React.ReactNode[] = [];
    let insideList = false;
    let currentListItems: React.ReactNode[] = [];

    const flushList = (key: number) => {
      if (currentListItems.length > 0) {
        parsedElements.push(
          <ul key={`list-${key}`} className="list-disc pl-5 my-2 space-y-1 text-slate-300">
            {currentListItems}
          </ul>
        );
        currentListItems = [];
        insideList = false;
      }
    };

    const flushTable = (key: number) => {
      if (tableRows.length > 0 || tableHeaders.length > 0) {
        parsedElements.push(
          <div key={`table-${key}`} className="my-3 overflow-x-auto rounded-xl border border-slate-800 shadow-lg">
            <table className="min-w-full divide-y divide-slate-800 text-xs">
              <thead className="bg-slate-900">
                <tr>
                  {tableHeaders.map((h, i) => (
                    <th key={i} className="px-4 py-2.5 text-left font-bold text-amber-350 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-850 bg-slate-950/20">
                {tableRows.map((row, ri) => (
                  <tr key={ri} className="hover:bg-slate-900/20 transition-all">
                    {row.map((cell, ci) => (
                      <td key={ci} className="px-4 py-2 font-medium text-slate-300">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        tableHeaders = [];
        tableRows = [];
        insideTable = false;
      }
    };

    const parseLineFormatting = (line: string): React.ReactNode => {
      const parts = line.split(/\*\*([\s\S]*?)\*\*/g);
      return parts.map((part, i) => {
        if (i % 2 === 1) {
          return <strong key={i} className="font-semibold text-amber-400">{part}</strong>;
        }
        return part;
      });
    };

    lines.forEach((line, index) => {
      const trimmed = line.trim();

      // 1. Table support
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        flushList(index);
        if (trimmed.includes('---') || trimmed.includes('===')) {
          return;
        }
        const cells = trimmed.split('|').map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
        if (!insideTable) {
          insideTable = true;
          tableHeaders = cells;
        } else {
          tableRows.push(cells);
        }
        return;
      } else {
        if (insideTable) {
          flushTable(index);
        }
      }

      // 2. Heading support
      if (trimmed.startsWith('### ')) {
        flushList(index);
        parsedElements.push(
          <h4 key={index} className="text-sm font-bold text-amber-400 mt-4 mb-1.5 tracking-tight">
            {parseLineFormatting(trimmed.substring(4))}
          </h4>
        );
        return;
      }
      if (trimmed.startsWith('## ')) {
        flushList(index);
        parsedElements.push(
          <h3 key={index} className="text-base font-bold text-amber-400 mt-5 mb-2 tracking-tight border-b border-slate-800 pb-1">
            {parseLineFormatting(trimmed.substring(3))}
          </h3>
        );
        return;
      }

      // 3. Unordered lists
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        insideList = true;
        const listText = trimmed.substring(2);
        currentListItems.push(
          <li key={`li-${index}`} className="text-xs">
            {parseLineFormatting(listText)}
          </li>
        );
        return;
      } else {
        if (insideList) {
          flushList(index);
        }
      }

      // 4. Empty line handling
      if (trimmed === '') {
        parsedElements.push(<div key={index} className="h-2" />);
        return;
      }

      // 5. Standard line
      parsedElements.push(
        <p key={index} className="text-xs md:text-sm my-1 font-light leading-relaxed">
          {parseLineFormatting(line)}
        </p>
      );
    });

    if (insideList) flushList(lines.length);
    if (insideTable) flushTable(lines.length);

    return <div className="space-y-1">{parsedElements}</div>;
  };

  return (
    <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className="flex flex-col h-full overflow-hidden bg-slate-900/10"
            >
              {/* Header Info */}
              <div className={`p-6 border-b shrink-0 transition-colors duration-200 ${
                isDarkMode ? 'bg-white/5 border-white/10 backdrop-blur-xl' : 'bg-white border-slate-200 shadow-sm'
              }`}>
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  <div>
                    <h2 className={`text-xl font-bold flex items-center tracking-tight transition-colors duration-200 ${
                      isDarkMode ? 'text-white' : 'text-slate-900'
                    }`}>
                      <Database className="h-5 w-5 mr-2.5 text-amber-400 animate-pulse" />
                      Asistente de Base de Datos O3 Copilot
                    </h2>
                    <p className={`text-xs mt-1 transition-colors duration-250 ${
                      isDarkMode ? 'text-slate-400' : 'text-slate-500'
                    }`}>
                      Realiza consultas inteligentes en tiempo real sobre tus chats y leads calificados en Firestore usando Inteligencia Artificial.
                    </p>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className={`text-[10px] font-mono px-2 py-1 rounded border ${
                      isDarkMode ? 'bg-slate-950 text-slate-400 border-slate-800' : 'bg-slate-50 text-slate-600 border-slate-250'
                    }`}>
                      Leads: {leads.length}
                    </span>
                    <span className={`text-[10px] font-mono px-2 py-1 rounded border ${
                      isDarkMode ? 'bg-slate-950 text-slate-400 border-slate-800' : 'bg-slate-50 text-slate-600 border-slate-250'
                    }`}>
                      Chats: {chats.length}
                    </span>
                    <button
                      onClick={() => {
                        setCopilotMessages([
                          {
                            sender: 'bot',
                            text: 'Conversación reiniciada. ¿En qué puedo ayudarte a buscar hoy?',
                            timestamp: new Date().toISOString()
                          }
                        ]);
                      }}
                      className={`text-xs py-1 px-2.5 rounded-lg border font-medium transition-all duration-150 cursor-pointer ${
                        isDarkMode
                          ? 'bg-slate-800 hover:bg-slate-750 text-slate-300 border-slate-700'
                          : 'bg-white hover:bg-slate-50 text-slate-700 border-slate-300'
                      }`}
                    >
                      Limpiar Chat
                    </button>
                  </div>
                </div>
              </div>

              {/* Chat Messages Area */}
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                {copilotMessages.map((msg, idx) => (
                  <div
                    key={idx}
                    className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[85%] md:max-w-[75%] rounded-2xl p-4 shadow-sm border transition-all duration-200 ${
                        msg.sender === 'user'
                          ? isDarkMode
                            ? 'bg-amber-400/10 border-amber-400/30 text-slate-150'
                            : 'bg-amber-50 border-amber-200 text-slate-850'
                          : isDarkMode
                          ? 'bg-slate-900 border-slate-800/80 text-slate-150'
                          : 'bg-white border-slate-250 text-slate-800'
                      }`}
                    >
                      {/* Message header */}
                      <div className="flex items-center space-x-1.5 mb-1.5 border-b border-amber-400/10 pb-1">
                        <span className="text-[10px] font-bold text-amber-400 tracking-wider uppercase">
                          {msg.sender === 'user' ? 'Tú (Ventas)' : 'Copiloto O3'}
                        </span>
                        <span className={`text-[9px] ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                          • {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      
                      {/* Message Body */}
                      <div className="text-sm leading-relaxed whitespace-pre-line prose max-w-none">
                        {renderCopilotMessageText(msg.text)}
                      </div>
                    </div>
                  </div>
                ))}
                
                {isCopilotTyping && (
                  <div className="flex justify-start">
                    <div className={`max-w-[85%] md:max-w-[75%] rounded-2xl p-4 shadow-sm border ${
                      isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-white/80 border-slate-200/60 backdrop-blur-xl'
                    }`}>
                      <div className="flex items-center space-x-2">
                        <div className="bg-amber-400/10 p-1.5 rounded-lg text-amber-400 border border-amber-400/20">
                          <Database className="h-3.5 w-3.5 animate-bounce" />
                        </div>
                        <span className="text-xs text-slate-400 animate-pulse font-medium">Consultando base de datos con IA...</span>
                      </div>
                    </div>
                  </div>
                )}
                <div ref={copilotEndRef} />
              </div>

              {/* Sugerencias y Formulario de Envío */}
              <div className={`p-4 border-t shrink-0 ${
                isDarkMode ? 'bg-slate-900/40 border-slate-800/80' : 'bg-slate-50 border-slate-200'
              }`}>
                {/* Sugerencias */}
                <div className="mb-3.5">
                  <span className={`text-[10px] font-bold tracking-wider uppercase block mb-1.5 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                    Consultas sugeridas en tiempo real:
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { label: '💰 Pipeline Total', query: '¿Cuánto es el valor de todas las cotizaciones?' },
                      { label: '🔥 Mayor Recibo', query: '¿Quién es el cliente con el recibo de luz más alto?' },
                      { label: '📊 Tasa de Contacto', query: '¿Qué porcentaje de los leads ya han sido contactados?' },
                      { label: '📋 Leads Pendientes', query: 'Muéstrame la lista detallada de los leads pendientes de revisión' },
                      { label: '💼 Resumen General', query: 'Genera un resumen ejecutivo de todos los prospectos de la base de datos' }
                    ].map((s, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => handleSendCopilotQuery(s.query)}
                        disabled={isCopilotTyping}
                        className={`text-xs py-1 px-2.5 rounded-lg border font-medium cursor-pointer transition-all duration-150 ${
                          isDarkMode
                            ? 'bg-slate-950/40 hover:bg-slate-900 border-slate-850 text-slate-300 hover:text-amber-300 hover:border-amber-400/30'
                            : 'bg-white hover:bg-slate-100 border-slate-200 text-slate-650 hover:text-amber-500 shadow-sm'
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Formulario */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSendCopilotQuery();
                  }}
                  className="flex items-center space-x-2"
                >
                  <input
                    type="text"
                    value={copilotInput}
                    onChange={(e) => setCopilotInput(e.target.value)}
                    placeholder="Escribe una pregunta sobre la base de datos (ej: ¿Cuántos leads giran arriba de $5000 MXN?)"
                    disabled={isCopilotTyping}
                    className={`flex-1 text-sm py-2.5 px-4 rounded-xl outline-none border transition-all duration-150 ${
                      isDarkMode
                        ? 'bg-slate-950 border-slate-850 text-white focus:border-amber-400 focus:ring-1 focus:ring-amber-400'
                        : 'bg-white border-slate-200 text-slate-850 focus:border-amber-400 focus:ring-1 focus:ring-amber-400 shadow-inner'
                    }`}
                  />
                  <button
                    type="submit"
                    disabled={isCopilotTyping || !copilotInput.trim()}
                    className={`p-2.5 rounded-xl text-white font-bold transition-all flex items-center justify-center cursor-pointer ${
                      copilotInput.trim() && !isCopilotTyping
                        ? 'bg-amber-400 hover:bg-amber-500 shadow-md shadow-amber-400/20'
                        : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-750'
                    }`}
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </form>
              </div>
            </motion.div>
  );
};


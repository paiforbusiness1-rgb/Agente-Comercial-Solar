import React from 'react';
import { Send, RefreshCw, Zap, Play, Check, Copy, Sparkles, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Chat } from '../types';

interface SimulatorViewProps {
  isDarkMode: boolean;
  chats: Chat[];
  simPhone: string;
  setSimPhone: (val: string) => void;
  simName: string;
  setSimName: (val: string) => void;
  simMessage: string;
  setSimMessage: (val: string) => void;
  simPayload: string;
  setSimPayload: (val: string) => void;
  simResponse: any;
  isSimulating: boolean;
  simulationLog: any[];
  setSimulationLog?: (log: any[]) => void;
  handleSimulateWebhook: (e: React.FormEvent) => void;
  copiedText: string | null;
  setCopiedText: (val: string | null) => void;
}

export const SimulatorView: React.FC<SimulatorViewProps> = ({
  isDarkMode,
  chats,
  simPhone,
  setSimPhone,
  simName,
  setSimName,
  simMessage,
  setSimMessage,
  simPayload,
  setSimPayload,
  simResponse,
  isSimulating,
  simulationLog,
  setSimulationLog,
  handleSimulateWebhook,
  copiedText,
  setCopiedText
}) => {
  return (
    <div className="p-8 h-full overflow-y-auto space-y-6">
              {/* Header */}
              <div className={`border-b pb-5 transition-colors duration-200 ${
                isDarkMode ? 'border-white/10' : 'border-slate-200/60'
              }`}>
                <h2 className={`text-2xl font-bold flex items-center tracking-tight transition-colors duration-200 ${
                  isDarkMode ? 'text-white' : 'text-slate-900'
                }`}>
                  <Sparkles className="h-6 w-6 mr-3 text-amber-400" />
                  Simulador de API / Webhook (Playground)
                </h2>
                <p className={`text-sm mt-1 font-light transition-colors duration-200 ${
                  isDarkMode ? 'text-slate-400' : 'text-slate-600'
                }`}>
                  Prueba la lógica conversacional del Bot de Gemini. Envía mensajes simulando ser un cliente y observa la extracción de parámetros y el historial de chat en tiempo real.
                </p>
              </div>

              {/* Simulator Panel */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                
                {/* Simulated Phone Interface */}
                <div className={`lg:col-span-5 flex flex-col border rounded-[2rem] overflow-hidden h-[650px] relative transition-all duration-200 ${
                  isDarkMode 
                    ? 'bg-slate-950 border-slate-800/80 shadow-2xl shadow-slate-950/80' 
                    : 'bg-white border-slate-300 shadow-xl'
                }`}>
                  
                  {/* Phone Header */}
                  <div className={`p-4 pt-6 flex items-center space-x-3 shadow-sm border-b transition-colors duration-200 ${
                    isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-slate-50 border-slate-200 text-slate-800'
                  }`}>
                    <div className="h-8 w-8 rounded-full bg-amber-400/10 border border-amber-400/20 flex items-center justify-center text-amber-400 font-bold">
                      O3
                    </div>
                    <div>
                      <h4 className="font-bold text-xs leading-none">O3 Energy México</h4>
                      <span className="text-[9px] text-amber-400 font-medium tracking-wide">Asistente Virtual de Ventas</span>
                    </div>
                  </div>

                  {/* WhatsApp Messages Canvas */}
                  <div className={`flex-1 overflow-y-auto p-4 space-y-3 transition-colors duration-200 ${
                    isDarkMode ? 'bg-slate-950' : 'bg-slate-50/50'
                  }`}>
                    <div className="text-center">
                      <span className={`text-[9px] font-semibold px-2.5 py-1 rounded border shadow-xs transition-colors duration-200 ${
                        isDarkMode 
                          ? 'bg-slate-900 text-slate-500 border-slate-850' 
                          : 'bg-white text-slate-500 border-slate-200'
                      }`}>
                        Mensajes procesados por Gemini AI para O3 Energy
                      </span>
                    </div>

                    {/* Show current selected chat messages if match, otherwise standard prompts */}
                    {chats.find(c => c.phone === simPhone)?.messages.map((m, i) => (
                      <div key={i} className={`flex ${m.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[80%] rounded-xl p-3 shadow-xs text-xs border transition-colors duration-200 ${
                          m.sender === 'user' 
                            ? isDarkMode
                              ? 'bg-amber-400/10 text-amber-300 border-amber-400/20 rounded-tr-none' 
                              : 'bg-amber-50 text-amber-700 border-amber-200 rounded-tr-none'
                            : isDarkMode
                            ? 'bg-slate-900 text-slate-200 border-slate-800 rounded-tl-none'
                            : 'bg-white text-slate-800 border-slate-200 rounded-tl-none'
                        }`}>
                          <p className="whitespace-pre-wrap font-light">{m.text}</p>
                          <span className="text-[8px] text-slate-400 text-right block mt-1 font-mono">
                            {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Simulator Trigger Input */}
                  <form onSubmit={handleSimulateWebhook} className={`p-4 border-t transition-colors duration-200 ${
                    isDarkMode ? 'bg-white/5 border-white/10 backdrop-blur-xl' : 'bg-white/80 border-slate-200/60 backdrop-blur-xl'
                  }`}>
                    <div className="flex flex-col space-y-2.5">
                      {/* Configuration fields */}
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] text-slate-500 font-semibold block mb-1">Nombre de Cliente</label>
                          <input 
                            type="text" 
                            value={simName}
                            onChange={(e) => setSimName(e.target.value)}
                            className={`w-full border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400/30 transition-colors duration-200 ${
                              isDarkMode ? 'bg-slate-950 border-slate-800 text-slate-200' : 'bg-slate-50 border-slate-250 text-slate-800'
                            }`}
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-slate-500 font-semibold block mb-1">Teléfono (Simulado)</label>
                          <input 
                            type="text" 
                            value={simPhone}
                            onChange={(e) => setSimPhone(e.target.value)}
                            className={`w-full border rounded-lg px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-amber-400/30 transition-colors duration-200 ${
                              isDarkMode ? 'bg-slate-950 border-slate-800 text-slate-200' : 'bg-slate-50 border-slate-250 text-slate-800'
                            }`}
                          />
                        </div>
                      </div>

                      {/* Quick helpers / Suggested prompts */}
                      <div>
                        <span className="text-[9px] text-slate-500 font-semibold block mb-1.5 uppercase tracking-wide">Inyecciones sugeridas para calificar rápido:</span>
                        <div className="flex flex-wrap gap-1">
                          <button
                            type="button"
                            onClick={() => setSimMessage('Hola, soy dueño de una casa en Guadalajara y pago $3,800 al bimestre')}
                            className={`text-[9px] border px-2.5 py-1 rounded-md transition cursor-pointer ${
                              isDarkMode 
                                ? 'bg-slate-950 hover:bg-slate-900 text-slate-300 border-slate-800' 
                                : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                            }`}
                          >
                            💡 "Soy dueño, gasto $3,800"
                          </button>
                          <button
                            type="button"
                            onClick={() => setSimMessage('Sí, la casa es mía, mi gasto mensual promedio es de unos $5,500 MXN')}
                            className={`text-[9px] border px-2.5 py-1 rounded-md transition cursor-pointer ${
                              isDarkMode 
                                ? 'bg-slate-950 hover:bg-slate-900 text-slate-300 border-slate-800' 
                                : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                            }`}
                          >
                            💡 "Soy dueño, gasto $5,500"
                          </button>
                          <button
                            type="button"
                            onClick={() => setSimMessage('Hola, soy arrendatario y pago $1,200 MXN')}
                            className={`text-[9px] border px-2.5 py-1 rounded-md transition cursor-pointer ${
                              isDarkMode 
                                ? 'bg-slate-950 hover:bg-slate-900 text-slate-300 border-slate-800' 
                                : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                            }`}
                          >
                            💡 "Rentado, gasto $1,200"
                          </button>
                        </div>
                      </div>

                      {/* Input send bar */}
                      <div className="flex space-x-2">
                        <input
                          type="text"
                          value={simMessage}
                          onChange={(e) => setSimMessage(e.target.value)}
                          placeholder="Escribe un mensaje de WhatsApp..."
                          className={`flex-1 border rounded-xl px-3.5 py-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-amber-400/20 focus:border-amber-400/40 transition-colors duration-200 ${
                            isDarkMode ? 'bg-slate-950 border-slate-800 text-slate-200' : 'bg-slate-50 border-slate-250 text-slate-800'
                          }`}
                          required
                        />
                        <button
                          type="submit"
                          disabled={isSimulating}
                          className="bg-amber-500 hover:bg-amber-600 text-white p-2.5 rounded-xl flex items-center justify-center transition cursor-pointer"
                        >
                          {isSimulating ? (
                            <RefreshCw className="h-4 w-4 animate-spin" />
                          ) : (
                            <Send className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                    </div>
                  </form>
                </div>

                {/* Developer / Webhook Inspector */}
                <div className="lg:col-span-7 space-y-6">
                  
                  {/* Webhook JSON Payload */}
                  <div className={`backdrop-blur-md rounded-2xl p-5 border shadow-lg space-y-3 transition-all duration-200 ${
                    isDarkMode ? 'bg-slate-900/30 border-slate-800/80 text-slate-300' : 'bg-white border-slate-200 text-slate-800'
                  }`}>
                    <div className={`flex items-center justify-between border-b pb-3 transition-colors duration-200 ${
                      isDarkMode ? 'border-slate-800' : 'border-slate-100'
                    }`}>
                      <span className="text-xs font-bold font-mono text-amber-400">POST /whatsapp-webhook</span>
                      <span className={`text-[10px] px-2.5 py-0.5 rounded font-bold font-mono ${
                        isDarkMode ? 'bg-slate-850 text-slate-400' : 'bg-slate-100 text-slate-500'
                      }`}>PAYLOAD INSPECTOR</span>
                    </div>
                    <div>
                      <p className={`text-xs mb-2 font-light ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>Este es el formato JSON idéntico enviado por el Webhook de WhatsApp a la API de nuestro servidor:</p>
                      <pre className="text-xs bg-slate-950 p-4 rounded-xl font-mono text-amber-400 overflow-x-auto max-h-40 border border-slate-900">
                        {simPayload || '// El payload se generará al enviar tu primer mensaje de simulación'}
                      </pre>
                    </div>
                  </div>

                  {/* Extraction JSON and response */}
                  {simResponse && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`backdrop-blur-md rounded-2xl p-5 border shadow-lg space-y-3 transition-all duration-200 ${
                        isDarkMode ? 'bg-slate-900/30 border-slate-800/80 text-slate-300' : 'bg-white border-slate-200 text-slate-800'
                      }`}
                    >
                      <div className={`flex items-center justify-between border-b pb-3 transition-colors duration-200 ${
                        isDarkMode ? 'border-slate-800' : 'border-slate-100'
                      }`}>
                        <span className="text-xs font-bold font-mono text-amber-400">EXTRACCIÓN INTELIGENTE GEMINI</span>
                        <span className={`text-[10px] border px-2 py-0.5 rounded font-bold font-mono ${
                          simResponse.lead_generated 
                            ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' 
                            : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                        }`}>
                          STATUS: {simResponse.lead_generated ? 'LEAD RECOPILADO' : 'PENDIENTE DE DATOS'}
                        </span>
                      </div>
                      
                      <div className="space-y-4">
                        <div>
                          <p className={`text-xs mb-2 font-light ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>Mensaje limpio final enviado al cliente (se removió el bloque JSON comercial Extractor):</p>
                          <div className={`p-4 rounded-xl text-xs font-sans border-l-4 border-amber-400 border transition-colors duration-200 ${
                            isDarkMode ? 'bg-slate-950 text-slate-200 border-slate-900' : 'bg-slate-50 text-slate-800 border-slate-200'
                          }`}>
                            {simResponse.reply}
                          </div>
                        </div>

                        {simResponse.lead_generated ? (
                          <div className="space-y-2">
                            <p className={`text-xs font-light ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>JSON de Lead calificado interceptado por el servidor:</p>
                            <pre className="text-xs bg-slate-950 p-4 rounded-xl font-mono text-amber-400 overflow-x-auto border border-slate-900">
                              {JSON.stringify(simResponse.chat, null, 2)}
                            </pre>
                          </div>
                        ) : (
                          <p className="text-xs text-amber-500 flex items-center font-light">
                            <Clock className="h-3.5 w-3.5 mr-1 text-amber-500 animate-spin" />
                            Conversación en curso. Preguntando por la propiedad de la casa y el monto del recibo de luz...
                          </p>
                        )}
                      </div>
                    </motion.div>
                  )}

                  {/* Simulator Live Logs */}
                  <div className={`backdrop-blur-md rounded-2xl p-5 border shadow-lg space-y-3 transition-all duration-200 ${
                    isDarkMode ? 'bg-slate-900/30 border-slate-800/80 text-slate-300' : 'bg-white border-slate-200 text-slate-800'
                  }`}>
                    <div className={`flex items-center justify-between border-b pb-3 transition-colors duration-200 ${
                      isDarkMode ? 'border-slate-800' : 'border-slate-100'
                    }`}>
                      <span className="text-xs font-bold font-mono text-slate-500">CONSOLA EN TIEMPO REAL (LOGS)</span>
                      <button 
                        onClick={() => setSimulationLog && setSimulationLog([])}
                        className={`text-[10px] transition cursor-pointer ${
                          isDarkMode ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'
                        }`}
                      >
                        Limpiar Consola
                      </button>
                    </div>
                    <div className={`space-y-1 max-h-40 overflow-y-auto font-mono text-xs transition-colors duration-200 ${
                      isDarkMode ? 'text-slate-400' : 'text-slate-600'
                    }`}>
                      {simulationLog.length === 0 ? (
                        <p className="text-slate-500 font-light">// Los logs de simulación aparecerán aquí...</p>
                      ) : (
                        simulationLog.map((log, index) => {
                          const isLead = log.includes('LEAD CALIFICADO');
                          const isErr = log.includes('ERROR');
                          return (
                            <p key={index} className={isLead ? 'text-amber-400 font-semibold' : isErr ? 'text-red-500' : 'font-light'}>
                              {log}
                            </p>
                          );
                        })
                      )}
                    </div>
                  </div>

                </div>
              </div>
            </div>
  );
};


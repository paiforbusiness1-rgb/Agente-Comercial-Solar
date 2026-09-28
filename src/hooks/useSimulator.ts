import React, { useState } from 'react';

interface UseSimulatorProps {
  showToast: (msg: string) => void;
}

export function useSimulator({ showToast }: UseSimulatorProps) {
  const [simPhone, setSimPhone] = useState('5215544332211');
  const [simName, setSimName] = useState('Alejandro Ruiz');
  const [simMessage, setSimMessage] = useState('Hola, buenas tardes, me interesa cotizar paneles para mi casa.');
  const [simPayload, setSimPayload] = useState<string>('');
  const [simResponse, setSimResponse] = useState<any>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationLog, setSimulationLog] = useState<string[]>([]);

  const handleSimulateWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!simPhone.trim() || !simMessage.trim()) return;

    setIsSimulating(true);
    setSimResponse(null);
    
    const payload = {
      phone: simPhone,
      text: simMessage,
      name: simName || 'Cliente Simulado'
    };
    
    setSimPayload(JSON.stringify(payload, null, 2));
    
    const logItem = `[${new Date().toLocaleTimeString()}] Enviando mensaje desde +${simPhone}: "${simMessage}"`;
    setSimulationLog(prev => [logItem, ...prev]);

    try {
      const response = await fetch('/api/whatsapp-webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (response.ok) {
        const data = await response.json();
        setSimResponse(data);
        
        const replyLog = `[${new Date().toLocaleTimeString()}] Respuesta recibida de Gemini AI: "${data.reply}"`;
        const leadLog = data.lead_generated 
          ? `[🔥 LEAD CALIFICADO] ¡Se detectó y registró un nuevo prospecto de paneles solares!`
          : `[💬 Conversación en curso] El bot sigue recopilando información.`;
          
        setSimulationLog(prev => {
          const logs = [leadLog, replyLog];
          if (data.email_sent) {
            logs.unshift(`[📧 EMAIL ENVIADO] ¡Notificación por correo enviada con éxito al equipo de ventas (ventas@o3energy.mx)!`);
          }
          return [...logs, ...prev];
        });
        showToast(data.lead_generated ? '🔥 ¡Nuevo Lead Calificado Detectado!' : 'Mensaje procesado con éxito');
      } else {
        const errorData = await response.text();
        setSimulationLog(prev => [`[❌ ERROR] Falló el webhook: ${errorData}`, ...prev]);
        showToast('Error en la simulación del Webhook');
      }
    } catch (err: any) {
      setSimulationLog(prev => [`[❌ ERROR RECHAZADO] No se pudo conectar: ${err.message}`, ...prev]);
      showToast('Error de red en la simulación');
    } finally {
      setIsSimulating(false);
      setSimMessage('');
    }
  };

  const handleResetDemo = async (setChats: (chats: any) => void, setLeads: (leads: any) => void, setSelectedChatPhone: (phone: string | null) => void) => {
    if (confirm('¿Estás seguro de que deseas limpiar todo el historial de chats y los leads calificados? Esta acción vaciará la base de datos de pruebas.')) {
      try {
        const response = await fetch('/api/reset-demo', { method: 'POST' });
        if (response.ok) {
          setChats([]);
          setLeads([]);
          setSelectedChatPhone(null);
          setSimulationLog([]);
          setSimResponse(null);
          showToast('🧹 Base de datos del Playground restablecida con éxito.');
        }
      } catch (err) {
        showToast('Error de red al restablecer base de datos.');
      }
    }
  };

  return {
    simPhone, setSimPhone,
    simName, setSimName,
    simMessage, setSimMessage,
    simPayload, setSimPayload,
    simResponse, setSimResponse,
    isSimulating, setIsSimulating,
    simulationLog, setSimulationLog,
    handleSimulateWebhook,
    handleResetDemo
  };
}

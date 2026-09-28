import React, { useState } from 'react';

export function useCopilot() {
  const [copilotMessages, setCopilotMessages] = useState<{ sender: 'user' | 'bot'; text: string; timestamp: string }[]>([
    {
      sender: 'bot',
      text: '¡Hola! Soy tu Copiloto Inteligente de Ventas de O3 Energy México. Pregúntame lo que quieras sobre los leads calificados, montos estimados de cotizaciones, proyecciones de ahorro o estadísticas generales de los chats.',
      timestamp: new Date().toISOString()
    }
  ]);
  const [copilotInput, setCopilotInput] = useState('');
  const [isCopilotTyping, setIsCopilotTyping] = useState(false);

  const handleSendCopilotQuery = async (queryInput?: string | React.FormEvent) => {
    let textToSend = '';

    if (typeof queryInput === 'string') {
      textToSend = queryInput;
    } else {
      if (queryInput && typeof queryInput === 'object' && 'preventDefault' in queryInput) {
        queryInput.preventDefault();
      }
      textToSend = copilotInput;
      setCopilotInput('');
    }

    if (!textToSend.trim() || isCopilotTyping) return;

    const userMsg = {
      sender: 'user' as const,
      text: textToSend,
      timestamp: new Date().toISOString()
    };

    setCopilotMessages(prev => [...prev, userMsg]);
    setIsCopilotTyping(true);

    try {
      const chatHistory = copilotMessages.slice(-10).map(m => ({
        sender: m.sender,
        text: m.text
      }));

      const res = await fetch('/api/copilot/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          question: textToSend,
          history: chatHistory
        })
      });

      if (!res.ok) {
        throw new Error('Error al conectar con el copiloto');
      }

      const data = await res.json();
      setCopilotMessages(prev => [...prev, {
        sender: 'bot' as const,
        text: data.answer,
        timestamp: new Date().toISOString()
      }]);
    } catch (err: any) {
      console.error('Error in copilot request:', err);
      setCopilotMessages(prev => [...prev, {
        sender: 'bot' as const,
        text: 'Lo siento, ocurrió un error al consultar la base de datos con la IA. Asegúrate de que el servidor esté activo y la API Key de Gemini esté configurada.',
        timestamp: new Date().toISOString()
      }]);
    } finally {
      setIsCopilotTyping(false);
    }
  };

  return {
    copilotMessages,
    setCopilotMessages,
    copilotInput,
    setCopilotInput,
    isCopilotTyping,
    handleSendCopilotQuery
  };
}

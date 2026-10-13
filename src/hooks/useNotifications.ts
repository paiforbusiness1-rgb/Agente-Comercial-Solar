import { useState, useEffect, useCallback } from 'react';
import { QualifiedLead } from '../types';

export function useNotifications() {
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>('default');

  useEffect(() => {
    if ('Notification' in window) {
      setNotificationPermission(Notification.permission);
    }
  }, []);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 4000);
  }, []);

  const requestNotificationPermission = async () => {
    if (!('Notification' in window)) {
      showToast('Tu navegador no soporta notificaciones de escritorio.');
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission === 'granted') {
        showToast('¡Notificaciones activadas con éxito!');
        new Notification('O3 Energy Alertas', {
          body: 'Notificaciones activadas para nuevos leads calificados.',
          icon: '/favicon.ico'
        });
      } else if (permission === 'denied') {
        showToast('Notificaciones rechazadas por el usuario.');
      }
    } catch (err) {
      console.error('Error requesting notification permission:', err);
    }
  };

  const triggerBrowserNotification = useCallback((lead: QualifiedLead, onNotificationClick: () => void) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      const title = `🚨 NUEVO LEAD CALIFICADO: ${lead.nombre || 'Cliente Nuevo'}`;
      const options = {
        body: `En espera de contacto para agendar cita. Recibo: ${lead.montoRecibo || 'Sin monto'} | Sistema: ${lead.sistemaEstimado || 'Sin sistema'}`,
        icon: '/favicon.ico',
        tag: lead.id,
        requireInteraction: true
      };

      const notification = new Notification(title, options);

      notification.onclick = () => {
        window.focus();
        onNotificationClick();
        notification.close();
      };
    }
  }, []);

  return {
    toastMessage,
    showToast,
    notificationPermission,
    requestNotificationPermission,
    triggerBrowserNotification
  };
}

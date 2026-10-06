import { useState, useEffect, useRef, useCallback } from 'react';
import { collection, onSnapshot, query, orderBy } from 'firebase/firestore';
import { db } from '../firebase';
import { Chat, QualifiedLead } from '../types';
import { SyncPolicyService, SyncState } from '../services/SyncPolicyService';

interface UseFirebaseProps {
  onNewLeadNotification: (lead: QualifiedLead) => void;
}

export type SyncStatus = 'connected' | 'polling_active' | 'sleeping' | 'background';

export function useFirebase({ onNewLeadNotification }: UseFirebaseProps) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [leads, setLeads] = useState<QualifiedLead[]>([]);
  
  const [isLoading, setIsLoading] = useState(true);
  const [isFirebaseConnected, setIsFirebaseConnected] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<string>('');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('connected');
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);

  const seenLeadIdsRef = useRef<Set<string>>(new Set());
  const isFirstLeadsLoadRef = useRef(true);

  // Instancia singleton de la política de sincronización adaptativa (Regla 3: Anti-God-Object)
  const syncPolicyRef = useRef<SyncPolicyService>(new SyncPolicyService());
  const isFetchingRef = useRef(false);
  const lastActivityTimeRef = useRef(Date.now());
  const lastRefreshTimeRef = useRef(0);

  // Keep a stable ref to the notification callback to prevent tearing down listeners on parent re-renders
  const onNewLeadNotificationRef = useRef(onNewLeadNotification);
  useEffect(() => {
    onNewLeadNotificationRef.current = onNewLeadNotification;
  }, [onNewLeadNotification]);

  // Silent background refresh function for specific actions (Credentials: include)
  const refreshChats = async () => {
    try {
      const chatsRes = await fetch('/api/v2/chats', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (chatsRes.ok) {
        const chatsData: Chat[] = await chatsRes.json();
        setChats(
          chatsData
            .filter((c) => (c as any).status !== 'deleted')
            .map((c) => ({
              ...c,
              phone: c.phone || c.id,
            }))
        );
      }
    } catch (err) {
      console.warn('[useFirebase] Error en refresco silencioso de chats:', err);
    }
  };

  // Función nuclear de sincronización controlada por SyncPolicyService y AbortController
  const fetchBackupData = useCallback(async (isManual = false) => {
    const policy = syncPolicyRef.current;

    // Refinamiento 1 (SSD): Anti-concurrencia
    if (isFetchingRef.current) {
      return;
    }

    const isVisible = typeof document !== 'undefined' ? !document.hidden : true;
    const now = Date.now();

    if (!isManual) {
      const decision = policy.shouldExecutePoll({
        isVisible,
        lastActivityMs: lastActivityTimeRef.current,
        lastRefreshMs: lastRefreshTimeRef.current,
        isFetching: isFetchingRef.current,
        currentTimeMs: now,
      });

      if (!decision.shouldPoll) {
        if (decision.shouldAbortInFlight) {
          policy.abortCurrentRequest('Cambio a modo reposo / segundo plano');
        }
        if (decision.state === 'BACKGROUND') {
          setSyncStatus('background');
        } else if (decision.state === 'IDLE_SLEEP') {
          setSyncStatus('sleeping');
        }
        return;
      }
    } else {
      policy.logManualSync();
      setIsManualRefreshing(true);
    }

    // Refinamiento 1 (SSD): Creación de AbortController activo para la petición en curso
    const controller = policy.createAbortController();
    const signal = controller.signal;
    isFetchingRef.current = true;
    setSyncStatus('polling_active');

    try {
      const [chatsRes, leadsRes] = await Promise.all([
        fetch('/api/v2/chats', {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          signal,
        }),
        fetch('/api/v2/leads', {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          signal,
        }),
      ]);

      if (chatsRes.ok) {
        const chatsData: Chat[] = await chatsRes.json();
        setChats(
          chatsData
            .filter((c) => (c as any).status !== 'deleted')
            .map((c) => ({
              ...c,
              phone: c.phone || c.id,
            }))
        );
      }
      
      if (leadsRes.ok) {
        const leadsData: QualifiedLead[] = await leadsRes.json();
        
        if (isFirstLeadsLoadRef.current) {
          leadsData.forEach((lead) => {
            seenLeadIdsRef.current.add(lead.id);
          });
          isFirstLeadsLoadRef.current = false;
        } else {
          leadsData.forEach((lead) => {
            if (!seenLeadIdsRef.current.has(lead.id)) {
              seenLeadIdsRef.current.add(lead.id);
              onNewLeadNotificationRef.current(lead);
            }
          });
        }

        setLeads(leadsData);
      }

      const refreshTimestamp = Date.now();
      lastRefreshTimeRef.current = refreshTimestamp;
      setLastRefreshed(new Date().toLocaleTimeString());
      setIsLoading(false);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // Cancelación activa legítima (Refinamiento 1)
        return;
      }
      console.warn('Backup HTTP sync failed:', err);
    } finally {
      isFetchingRef.current = false;
      setIsManualRefreshing(false);
    }
  }, []);

  // Refresco manual explícito (Refinamiento 3 - U-First)
  const triggerManualRefresh = useCallback(() => {
    lastActivityTimeRef.current = Date.now();
    fetchBackupData(true);
  }, [fetchBackupData]);

  useEffect(() => {
    let unsubscribeChats: () => void = () => {};
    let unsubscribeLeads: () => void = () => {};
    let isFallbackActive = false;
    let evaluationInterval: NodeJS.Timeout | null = null;

    const policy = syncPolicyRef.current;

    // Actualiza el timestamp de actividad humana (mouse, teclado, touch)
    const handleUserActivity = () => {
      const now = Date.now();
      const wasSleeping = now - lastActivityTimeRef.current >= policy.idleTimeoutMs;
      lastActivityTimeRef.current = now;

      // Si estaba dormido, despierta y si los datos superan el umbral de frescura, refresca de inmediato
      if (wasSleeping && isFallbackActive) {
        const wakeup = policy.evaluateWakeup(lastRefreshTimeRef.current, now);
        if (wakeup.shouldRefreshImmediately) {
          fetchBackupData(false);
        }
      }
    };

    // Refinamiento 1 & 3: Manejo de visibilidad de pestaña (document.hidden)
    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') return;

      if (document.hidden) {
        // Pestaña oculta: Abortar inmediatamente cualquier petición activa y pausar
        policy.abortCurrentRequest('Pestaña en segundo plano (document.hidden)');
        setSyncStatus('background');
      } else {
        // Pestaña visible de nuevo: Resetear actividad y evaluar refresco inmediato
        lastActivityTimeRef.current = Date.now();
        if (isFallbackActive) {
          const wakeup = policy.evaluateWakeup(lastRefreshTimeRef.current, Date.now());
          if (wakeup.shouldRefreshImmediately) {
            fetchBackupData(false);
          }
        }
      }
    };

    // Inicia el loop adaptativo de baja frecuencia (Regla HRU: Cero Polling Ciego de 3s)
    const startAdaptiveSyncFallback = () => {
      if (isFallbackActive) return;
      isFallbackActive = true;
      setIsFirebaseConnected(false);
      setSyncStatus('polling_active');

      // Primer fetch de arranque
      fetchBackupData(false);

      // Evaluación periódica cada 10s: Solo ejecuta red si SyncPolicyService lo autoriza (>= 60s)
      evaluationInterval = setInterval(() => {
        fetchBackupData(false);
      }, 10000);
    };

    // Listeners de actividad del usuario en la ventana
    if (typeof window !== 'undefined') {
      window.addEventListener('mousemove', handleUserActivity, { passive: true });
      window.addEventListener('keydown', handleUserActivity, { passive: true });
      window.addEventListener('touchstart', handleUserActivity, { passive: true });
      window.addEventListener('scroll', handleUserActivity, { passive: true });
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    try {
      const connectionTimeout = setTimeout(() => {
        console.warn('Firebase connection timeout (silent error). Switching to Adaptive Zero-Spam Sync...');
        startAdaptiveSyncFallback();
      }, 3500);

      const chatsQuery = query(collection(db, 'tenants/o3energy_mexico/chats'), orderBy('lastMessageAt', 'desc'));
      unsubscribeChats = onSnapshot(chatsQuery, (snapshot) => {
        clearTimeout(connectionTimeout);
        const chatsList: Chat[] = [];
        snapshot.forEach((doc) => {
          const data = doc.data() as any;
          if (data.status !== 'deleted') {
            chatsList.push({
              id: doc.id,
              phone: data.phone || doc.id,
              ...data,
            });
          }
        });
        setChats(chatsList);
        setIsLoading(false);
        setIsFirebaseConnected(true);
        setSyncStatus('connected');
        setLastRefreshed(new Date().toLocaleTimeString());
      }, (error) => {
        clearTimeout(connectionTimeout);
        console.warn('Firestore chats subscription failed. Switching to Adaptive Zero-Spam Sync:', error);
        startAdaptiveSyncFallback();
      });

      const leadsQuery = query(collection(db, 'tenants/o3energy_mexico/qualified_leads'), orderBy('createdAt', 'desc'));
      unsubscribeLeads = onSnapshot(leadsQuery, (snapshot) => {
        const leadsList: QualifiedLead[] = [];
        snapshot.forEach((doc) => {
          leadsList.push({ id: doc.id, ...(doc.data() as any) });
        });

        if (isFirstLeadsLoadRef.current) {
          snapshot.forEach((doc) => {
            seenLeadIdsRef.current.add(doc.id);
          });
          isFirstLeadsLoadRef.current = false;
        } else {
          snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
              const docId = change.doc.id;
              if (!seenLeadIdsRef.current.has(docId)) {
                seenLeadIdsRef.current.add(docId);
                const leadData = { id: docId, ...change.doc.data() } as QualifiedLead;
                onNewLeadNotificationRef.current(leadData);
              }
            }
          });
        }

        setLeads(leadsList);
      }, (error) => {
        console.warn('Firestore leads subscription failed:', error);
      });

    } catch (err) {
      console.error('Error initializing Firestore Listeners:', err);
      startAdaptiveSyncFallback();
    }

    return () => {
      unsubscribeChats();
      unsubscribeLeads();
      if (evaluationInterval) clearInterval(evaluationInterval);
      policy.abortCurrentRequest('Hook desmontado');

      if (typeof window !== 'undefined') {
        window.removeEventListener('mousemove', handleUserActivity);
        window.removeEventListener('keydown', handleUserActivity);
        window.removeEventListener('touchstart', handleUserActivity);
        window.removeEventListener('scroll', handleUserActivity);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [fetchBackupData]);

  return {
    chats,
    setChats,
    leads,
    setLeads,
    isLoading,
    isFirebaseConnected,
    lastRefreshed,
    refreshChats,
    syncStatus,
    isManualRefreshing,
    triggerManualRefresh,
  };
}

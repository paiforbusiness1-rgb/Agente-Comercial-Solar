/**
 * src/hooks/useAuth.ts
 * Authentication hook relying strictly on HttpOnly cookies (Refinamiento A).
 * Credentials mode: 'include' for zero-trust client token management.
 */

import { useState, useEffect, useCallback } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

export interface User {
  id: string;
  email: string;
  role: 'admin' | 'agent' | 'viewer';
}

// Initialize Firebase client app (idempotent)
const firebaseApp = getApps().length === 0
  ? initializeApp(firebaseConfig)
  : getApps()[0];
const googleProvider = new GoogleAuthProvider();

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Verifies current session state against backend /api/v2/auth/me
   */
  const checkAuthStatus = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/v2/auth/me', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // Includes HttpOnly cookie
      });

      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
        setIsAuthenticated(true);
      } else {
        setUser(null);
        setIsAuthenticated(false);
      }
    } catch (err: any) {
      console.warn('[useAuth] Failed to verify auth session:', err.message);
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuthStatus();
  }, [checkAuthStatus]);

  /**
   * Authenticates user against /api/v2/auth/login
   */
  const login = async (email: string, pass: string): Promise<boolean> => {
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/v2/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // Saves HttpOnly cookie returned by server
        body: JSON.stringify({ email, password: pass }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Error al iniciar sesión');
        setIsLoading(false);
        return false;
      }

      setUser(data.user);
      setIsAuthenticated(true);
      setIsLoading(false);
      return true;
    } catch (err: any) {
      setError(err.message || 'Error de red al conectar con el servidor de autenticación');
      setIsLoading(false);
      return false;
    }
  };

  /**
   * Authenticates user via Google OAuth popup → Firebase ID Token → backend /auth/google
   */
  const loginWithGoogle = async (): Promise<boolean> => {
    setIsLoading(true);
    setError(null);

    try {
      const auth = getAuth(firebaseApp);
      const result = await signInWithPopup(auth, googleProvider);
      const idToken = await result.user.getIdToken();

      const res = await fetch('/api/v2/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ idToken }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Error al iniciar sesión con Google');
        setIsLoading(false);
        return false;
      }

      setUser(data.user);
      setIsAuthenticated(true);
      setIsLoading(false);
      return true;
    } catch (err: any) {
      // Firebase popup errors (cancelled by user, popup blocked, etc.)
      if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
        setError(null); // Not a real error — user cancelled
      } else {
        setError(err.message || 'Error al conectar con Google');
      }
      setIsLoading(false);
      return false;
    }
  };

  /**
   * Logs out user by calling /api/v2/auth/logout
   */
  const logout = async () => {
    setIsLoading(true);
    try {
      await fetch('/api/v2/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
    } catch (err) {
      console.error('[useAuth] Logout error:', err);
    } finally {
      setUser(null);
      setIsAuthenticated(false);
      setIsLoading(false);
    }
  };

  return {
    user,
    isAuthenticated,
    isLoading,
    error,
    login,
    loginWithGoogle,
    logout,
    checkAuthStatus,
  };
}

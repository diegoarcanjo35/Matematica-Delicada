import { useCallback, useEffect, useState, type ReactNode } from "react";
import { fetchSession, login as apiLogin, logout as apiLogout, type PublicUser } from "../api/authClient";
import { AuthContext, type AuthStatus } from "./authContextStore";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<PublicUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchSession();
      setUser(result.user);
      setStatus("authenticated");
    } catch {
      setUser(null);
      setStatus("unauthenticated");
    }
  }, []);

  useEffect(() => {
    // Consulta a sessão real no servidor ao montar — não há como "sincronizar"
    // isso de outra forma, pois é a própria fonte da verdade (cookie HttpOnly).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await apiLogin({ email, password });
    setUser(result.user);
    setStatus("authenticated");
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  return (
    <AuthContext.Provider value={{ status, user, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

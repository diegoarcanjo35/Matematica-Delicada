import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./useAuth";
import { LoadingState } from "../components/LoadingState";

/* Proteção real de rota — depende só da sessão validada no servidor (useAuth
   consulta /api/auth/session, que lê o cookie HttpOnly). Nunca confia em estado
   local isolado nem em localStorage/sessionStorage. */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return <LoadingState label="Verificando sua sessão…" />;
  }

  if (status === "unauthenticated") {
    const destination = `${location.pathname}${location.search}`;
    return <Navigate to="/entrar" state={{ from: destination }} replace />;
  }

  return <>{children}</>;
}

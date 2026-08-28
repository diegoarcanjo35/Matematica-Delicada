import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./useAuth";
import { LoadingState } from "../components/LoadingState";

interface LocationState {
  from?: string;
}

/* Telas de "Entrar"/"Criar conta" não devem ser mostradas a quem já tem sessão válida.
   Esta é a ÚNICA fonte de verdade para o redirecionamento pós-login — LoginPage não
   navega manualmente após o login, justamente para não competir com este redirect
   declarativo (duas navegações disputando o mesmo destino causavam uma corrida que
   às vezes perdia o "retorno ao destino pretendido"). */
export function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return <LoadingState label="Verificando sua sessão…" />;
  }

  if (status === "authenticated") {
    const destination = (location.state as LocationState | null)?.from ?? "/";
    return <Navigate to={destination} replace />;
  }

  return <>{children}</>;
}

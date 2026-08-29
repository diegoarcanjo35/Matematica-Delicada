import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useOnboardingStatus } from "../onboarding/useOnboardingStatus";
import { LoadingState } from "../components/LoadingState";

/* Rota estritamente necessária que nunca deve virar armadilha de navegação
   durante o onboarding incompleto (Documento Mestre / Sprint 3, seção 10):
   logout já é acessível diretamente na própria tela de onboarding
   (OnboardingPage), então esta lista existe só para casos futuros. */
const ALWAYS_ALLOWED_PATHS = new Set<string>([]);

export function RequireOnboardingComplete({ children }: { children: ReactNode }) {
  const { status } = useOnboardingStatus();
  const location = useLocation();

  if (ALWAYS_ALLOWED_PATHS.has(location.pathname)) {
    return <>{children}</>;
  }

  if (status === "loading") {
    return <LoadingState label="Carregando seu progresso…" />;
  }

  if (status === "incomplete") {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
}

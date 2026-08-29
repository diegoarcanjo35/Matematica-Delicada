import { useCallback, useEffect, useState, type ReactNode } from "react";
import { fetchOnboarding, type OnboardingProfile } from "../api/onboardingClient";
import { OnboardingStatusContext, type OnboardingStatus } from "./onboardingStatusStore";

/* Consulta /api/onboarding uma vez por sessão de navegação autenticada (não a
   cada troca de rota) — evitado por RequireOnboardingComplete e pelas telas
   que precisam do nome/meta reais (Dashboard, Configurações) via
   useOnboardingStatus(), sem duplicar a requisição. */
export function OnboardingStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<OnboardingStatus>("loading");
  const [profile, setProfile] = useState<OnboardingProfile | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchOnboarding();
      setProfile(result.profile);
      setStatus(result.profile.status === "completed" ? "complete" : "incomplete");
    } catch {
      setProfile(null);
      setStatus("incomplete");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return (
    <OnboardingStatusContext.Provider value={{ status, profile, refresh }}>
      {children}
    </OnboardingStatusContext.Provider>
  );
}

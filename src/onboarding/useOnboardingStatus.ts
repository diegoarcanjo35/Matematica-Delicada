import { useContext } from "react";
import { OnboardingStatusContext, type OnboardingStatusContextValue } from "./onboardingStatusStore";

export function useOnboardingStatus(): OnboardingStatusContextValue {
  const context = useContext(OnboardingStatusContext);
  if (!context) throw new Error("useOnboardingStatus deve ser usado dentro de <OnboardingStatusProvider>.");
  return context;
}

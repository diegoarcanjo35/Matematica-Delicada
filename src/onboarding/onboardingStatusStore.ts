import { createContext } from "react";
import type { OnboardingProfile } from "../api/onboardingClient";

export type OnboardingStatus = "loading" | "incomplete" | "complete";

export interface OnboardingStatusContextValue {
  status: OnboardingStatus;
  profile: OnboardingProfile | null;
  refresh: () => Promise<void>;
}

export const OnboardingStatusContext = createContext<OnboardingStatusContextValue | null>(null);

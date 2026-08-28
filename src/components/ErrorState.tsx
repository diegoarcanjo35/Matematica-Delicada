import type { ReactNode } from "react";
import "./StateViews.css";

interface ErrorStateProps {
  title?: string;
  description?: string;
  action?: ReactNode;
}

export function ErrorState({
  title = "Algo não saiu como esperado",
  description = "Tente novamente em instantes. Se o problema continuar, avise o suporte.",
  action,
}: ErrorStateProps) {
  return (
    <div className="state-view state-view--error" role="alert">
      <p className="state-view__title">{title}</p>
      <p className="state-view__description">{description}</p>
      {action}
    </div>
  );
}

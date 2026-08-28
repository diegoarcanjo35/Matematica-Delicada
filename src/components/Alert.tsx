import type { ReactNode } from "react";
import "./Alert.css";

type AlertVariant = "info" | "success" | "warning" | "error";

const VARIANT_ICON: Record<AlertVariant, string> = {
  info: "ℹ",
  success: "✓",
  warning: "!",
  error: "✕",
};

interface AlertProps {
  variant?: AlertVariant;
  title?: string;
  children: ReactNode;
}

export function Alert({ variant = "info", title, children }: AlertProps) {
  const role = variant === "error" || variant === "warning" ? "alert" : "status";

  return (
    <div className={`alert alert--${variant}`} role={role}>
      <span className="alert__icon" aria-hidden="true">
        {VARIANT_ICON[variant]}
      </span>
      <div>
        {title && <p className="alert__title">{title}</p>}
        <div className="alert__body">{children}</div>
      </div>
    </div>
  );
}

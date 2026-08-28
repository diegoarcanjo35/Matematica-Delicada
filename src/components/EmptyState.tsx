import type { ReactNode } from "react";
import "./StateViews.css";

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="state-view state-view--empty">
      <p className="state-view__title">{title}</p>
      {description && <p className="state-view__description">{description}</p>}
      {action}
    </div>
  );
}

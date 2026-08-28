import "./StateViews.css";

interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = "Carregando…" }: LoadingStateProps) {
  return (
    <div className="state-view state-view--loading" role="status" aria-live="polite">
      <span className="state-view__spinner" aria-hidden="true" />
      <p className="state-view__title">{label}</p>
    </div>
  );
}

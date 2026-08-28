import "./ProgressBar.css";

interface ProgressBarProps {
  label: string;
  value: number;
  max?: number;
  showValue?: boolean;
}

export function ProgressBar({ label, value, max = 100, showValue = true }: ProgressBarProps) {
  const percent = Math.max(0, Math.min(100, Math.round((value / max) * 100)));

  return (
    <div className="progress-bar">
      <div className="progress-bar__header">
        <span className="progress-bar__label">{label}</span>
        {showValue && <span className="progress-bar__value">{percent}%</span>}
      </div>
      <div
        className="progress-bar__track"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className="progress-bar__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

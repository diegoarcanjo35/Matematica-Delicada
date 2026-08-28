import { useId, useState, type ReactNode } from "react";
import "./Tooltip.css";

interface TooltipProps {
  text: string;
  children: ReactNode;
}

export function Tooltip({ text, children }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const tooltipId = useId();

  return (
    <span
      className="tooltip"
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
      onFocus={() => setIsVisible(true)}
      onBlur={() => setIsVisible(false)}
    >
      <span aria-describedby={isVisible ? tooltipId : undefined}>{children}</span>
      <span role="tooltip" id={tooltipId} className="tooltip__bubble" hidden={!isVisible}>
        {text}
      </span>
    </span>
  );
}

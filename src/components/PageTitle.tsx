import type { ReactNode } from "react";
import "./PageTitle.css";

interface PageTitleProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function PageTitle({ title, description, action }: PageTitleProps) {
  return (
    <div className="page-title">
      <div>
        <h2 className="page-title__heading">{title}</h2>
        {description && <p className="page-title__description">{description}</p>}
      </div>
      {action}
    </div>
  );
}

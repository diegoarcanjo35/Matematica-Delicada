import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import "./AuthLayout.css";

interface AuthLayoutProps {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function AuthLayout({ title, description, children, footer }: AuthLayoutProps) {
  return (
    <div className="auth-layout">
      <a href="#auth-main" className="skip-link">
        Pular para o conteúdo
      </a>
      <div className="auth-layout__panel">
        <Link to="/" className="auth-layout__brand" aria-label="Matemática Delicada">
          <span className="auth-layout__brand-mark" aria-hidden="true">
            MD
          </span>
          Matemática Delicada
        </Link>
        <p className="auth-layout__tagline">O contexto muda. O padrão se repete.</p>
      </div>
      <main id="auth-main" className="auth-layout__content">
        <div className="auth-layout__card">
          <h1 className="auth-layout__title">{title}</h1>
          {description && <p className="auth-layout__description">{description}</p>}
          {children}
          {footer && <div className="auth-layout__footer">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

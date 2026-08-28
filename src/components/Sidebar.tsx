import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { STUDENT_NAV_ITEMS } from "../routes/studentNav";
import { useAuth } from "../auth/useAuth";
import "./Sidebar.css";

/* Sidebar recolhível — Documento Mestre 20.5: "tablet: sidebar recolhível e
   cards em duas colunas". O botão abaixo permite recolher para uma trilha
   de ícones em qualquer largura em que a sidebar apareça (tablet e desktop). */
export function Sidebar() {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  async function handleLogout() {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      await logout();
      navigate("/entrar", { replace: true });
    } finally {
      setIsLoggingOut(false);
    }
  }

  return (
    <nav
      className={`sidebar${isCollapsed ? " sidebar--collapsed" : ""}`}
      aria-label="Navegação principal"
    >
      <div className="sidebar__brand">
        <span className="sidebar__brand-mark" aria-hidden="true">
          MD
        </span>
        {!isCollapsed && <span className="sidebar__brand-name">Matemática Delicada</span>}
        <button
          type="button"
          className="sidebar__collapse-toggle"
          onClick={() => setIsCollapsed((collapsed) => !collapsed)}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? "Expandir navegação" : "Recolher navegação"}
          title={isCollapsed ? "Expandir navegação" : "Recolher navegação"}
        >
          {isCollapsed ? "»" : "«"}
        </button>
      </div>

      <ul className="sidebar__list">
        {STUDENT_NAV_ITEMS.map((item) => (
          <li key={item.path}>
            <NavLink
              to={item.path}
              end={item.path === "/"}
              className={({ isActive }) =>
                `sidebar__link${isActive ? " sidebar__link--active" : ""}`
              }
              title={isCollapsed ? item.label : undefined}
            >
              <span className="sidebar__icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className={isCollapsed ? "visually-hidden" : undefined}>{item.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="sidebar__footer">
        <NavLink to="/configuracoes" className="sidebar__footer-link" title="Configurações">
          {isCollapsed ? <span aria-hidden="true">⚙️</span> : null}
          <span className={isCollapsed ? "visually-hidden" : undefined}>Configurações</span>
        </NavLink>
        <NavLink to="/ajuda" className="sidebar__footer-link" title="Ajuda/Suporte">
          {isCollapsed ? <span aria-hidden="true">❓</span> : null}
          <span className={isCollapsed ? "visually-hidden" : undefined}>Ajuda/Suporte</span>
        </NavLink>
        <NavLink to="/assinatura" className="sidebar__footer-link" title="Assinatura/Plano">
          {isCollapsed ? <span aria-hidden="true">💳</span> : null}
          <span className={isCollapsed ? "visually-hidden" : undefined}>Assinatura/Plano</span>
        </NavLink>
        <button
          type="button"
          className="sidebar__footer-link sidebar__footer-link--button"
          onClick={handleLogout}
          disabled={isLoggingOut}
          title="Sair"
        >
          {isCollapsed ? <span aria-hidden="true">🚪</span> : null}
          <span className={isCollapsed ? "visually-hidden" : undefined}>
            {isLoggingOut ? "Saindo…" : "Sair"}
          </span>
        </button>
      </div>
    </nav>
  );
}

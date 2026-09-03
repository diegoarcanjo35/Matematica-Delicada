import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Header } from "../components/Header";
import { useAuth } from "../auth/useAuth";
import "../components/Sidebar.css";
import "../components/MobileNav.css";
import "./AdminLayout.css";

/* Layout da área administrativa — Sprint 15 v1.0, seção 8/19 da ordem.
   Mesmo padrão de src/layouts/TeacherLayout.tsx: navegação própria, mínima
   (seção 19: "não criar placeholders de funcionalidades futuras").
   Sprint 16 v1.2, seção 9 da ordem — três itens novos: os pipelines
   administrativos mínimos de conteúdo (Diagnóstico/Cronograma/Padrões),
   integrados a esta MESMA área (nenhum dashboard novo, nenhuma navegação
   paralela). */

const ADMIN_NAV_ITEMS = [
  { path: "/admin", label: "Visão Geral", icon: "🏠", end: true },
  { path: "/admin/usuarios", label: "Usuários", icon: "👥", end: false },
  { path: "/admin/vinculos", label: "Vínculos", icon: "🔗", end: false },
  { path: "/admin/diagnostico", label: "Diagnóstico", icon: "📝", end: false },
  { path: "/admin/cronograma", label: "Cronograma", icon: "🗓️", end: false },
  { path: "/admin/padroes", label: "Padrões", icon: "🧩", end: false },
] as const;

export function AdminLayout() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/entrar", { replace: true });
  }

  return (
    <div className="student-layout admin-layout">
      <a href="#admin-main-content" className="skip-link">
        Pular para o conteúdo
      </a>
      <nav className="sidebar" aria-label="Navegação da administração">
        <div className="sidebar__brand">
          <span className="sidebar__brand-mark" aria-hidden="true">
            MD
          </span>
          <span className="sidebar__brand-name">Administração</span>
        </div>
        <ul className="sidebar__list">
          {ADMIN_NAV_ITEMS.map((item) => (
            <li key={item.path}>
              <NavLink to={item.path} end={item.end} className={({ isActive }) => `sidebar__link${isActive ? " sidebar__link--active" : ""}`}>
                <span className="sidebar__icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span>{item.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="sidebar__footer">
          <button type="button" className="sidebar__footer-link sidebar__footer-link--button" onClick={() => void handleLogout()}>
            <span>Sair</span>
          </button>
        </div>
      </nav>

      <div className="student-layout__main">
        <Header title="Administração" />
        <main id="admin-main-content" className="student-layout__content">
          <Outlet />
        </main>
      </div>

      <nav className="mobile-nav" aria-label="Navegação móvel da administração">
        {ADMIN_NAV_ITEMS.map((item) => (
          <NavLink key={item.path} to={item.path} end={item.end} className={({ isActive }) => `mobile-nav__link${isActive ? " mobile-nav__link--active" : ""}`}>
            <span aria-hidden="true">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
        <button type="button" className="mobile-nav__link" onClick={() => void handleLogout()}>
          <span aria-hidden="true">🚪</span>
          Sair
        </button>
      </nav>
    </div>
  );
}

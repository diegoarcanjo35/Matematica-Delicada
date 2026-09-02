import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Header } from "../components/Header";
import { useAuth } from "../auth/useAuth";
import "../components/Sidebar.css";
import "../components/MobileNav.css";
import "./TeacherLayout.css";

/* Layout da área do professor — Sprint 14 v1.0, seção 10/19 da ordem.

   Deliberadamente SEPARADO de StudentLayout.tsx/Sidebar.tsx/MobileNav.tsx
   (que são amarrados a STUDENT_NAV_ITEMS): a navegação do professor tem
   hoje só DOIS itens reais (Visão Geral, Alunos — seção 19), então não há
   "mais opções"/overflow a resolver. Reaproveita as classes CSS já
   existentes de .sidebar/.mobile-nav (mesmo visual/comportamento
   responsivo do resto do app) e o componente Header — nunca duplica
   design system, só não reaproveita os DOIS componentes que estão
   hard-coded para a navegação do aluno. */

const TEACHER_NAV_ITEMS = [
  { path: "/professor", label: "Visão Geral", icon: "🏠", end: true },
  { path: "/professor/alunos", label: "Alunos", icon: "🎓", end: false },
] as const;

export function TeacherLayout() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/entrar", { replace: true });
  }

  return (
    <div className="student-layout teacher-layout">
      <a href="#teacher-main-content" className="skip-link">
        Pular para o conteúdo
      </a>
      <nav className="sidebar" aria-label="Navegação do professor">
        <div className="sidebar__brand">
          <span className="sidebar__brand-mark" aria-hidden="true">
            MD
          </span>
          <span className="sidebar__brand-name">Painel do Professor</span>
        </div>
        <ul className="sidebar__list">
          {TEACHER_NAV_ITEMS.map((item) => (
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
        <Header title="Painel do Professor" />
        <main id="teacher-main-content" className="student-layout__content">
          <Outlet />
        </main>
      </div>

      <nav className="mobile-nav" aria-label="Navegação móvel do professor">
        {TEACHER_NAV_ITEMS.map((item) => (
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

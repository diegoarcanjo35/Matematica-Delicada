import { Outlet } from "react-router-dom";
import { Header } from "../components/Header";
import { Sidebar } from "../components/Sidebar";
import { MobileNav } from "../components/MobileNav";
import "./StudentLayout.css";

export function StudentLayout() {
  return (
    <div className="student-layout">
      <a href="#main-content" className="skip-link">
        Pular para o conteúdo
      </a>
      <Sidebar />
      <div className="student-layout__main">
        <Header title="Matemática Delicada" />
        <main id="main-content" className="student-layout__content">
          <Outlet />
        </main>
      </div>
      <MobileNav />
    </div>
  );
}

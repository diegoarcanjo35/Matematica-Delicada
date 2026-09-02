import { Link } from "react-router-dom";
import { PageTitle } from "../../components/PageTitle";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { useAdminDashboard } from "../../auth/adminDashboardContext";
import "./AdminPages.css";

/* /admin — Visão Geral (ordem seção 9). O dashboard já chegou pronto via
   AdminDashboardContext (buscado uma única vez por RequireAdminRole.tsx) —
   esta tela nunca refaz a requisição. Só contagens factuais (seção 9: "não
   implementar analytics de negócio complexo" — nada de crescimento/
   retenção/receita/churn). */
export function AdminOverviewPage() {
  const dashboard = useAdminDashboard();

  if (!dashboard) {
    return <EmptyState title="Painel indisponível" description="Recarregue a página para tentar novamente." />;
  }

  const { totalUsers, usersByRole, usersWithoutRole, activeTeacherStudentBonds, inactiveTeacherStudentBonds } = dashboard;
  const roleEntries = Object.entries(usersByRole).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="admin-page">
      <PageTitle title="Visão Geral" description="Resumo factual de usuários, papéis e vínculos professor-aluno." />

      <section className="admin-page__stats" aria-label="Usuários">
        <Card className="admin-page__stat-card">
          <span className="admin-page__stat-value">{totalUsers}</span>
          <span className="admin-page__stat-label">Total de usuários</span>
        </Card>
        <Card className="admin-page__stat-card">
          <span className="admin-page__stat-value">{usersWithoutRole}</span>
          <span className="admin-page__stat-label">Sem nenhum papel atribuído</span>
        </Card>
        <Card className="admin-page__stat-card">
          <span className="admin-page__stat-value">{activeTeacherStudentBonds}</span>
          <span className="admin-page__stat-label">Vínculos professor-aluno ativos</span>
        </Card>
        <Card className="admin-page__stat-card">
          <span className="admin-page__stat-value">{inactiveTeacherStudentBonds}</span>
          <span className="admin-page__stat-label">Vínculos professor-aluno inativos</span>
        </Card>
      </section>

      <section aria-labelledby="admin-roles-heading">
        <h2 id="admin-roles-heading" className="admin-page__section-title">
          Usuários por papel
        </h2>
        {roleEntries.length === 0 ? (
          <EmptyState title="Nenhum papel atribuído ainda" description="Nenhum usuário da plataforma tem um papel atribuído no momento." />
        ) : (
          <Card>
            <div className="admin-page__stats">
              {roleEntries.map(([role, count]) => (
                <div key={role} className="admin-page__stat-card">
                  <span className="admin-page__stat-value">{count}</span>
                  <span className="admin-page__stat-label">{role}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </section>

      <section aria-labelledby="admin-shortcuts-heading">
        <h2 id="admin-shortcuts-heading" className="admin-page__section-title">
          Ações rápidas
        </h2>
        <div className="admin-page__filters">
          <Link to="/admin/usuarios" className="btn btn--secondary">
            <span>Gerenciar usuários</span>
          </Link>
          <Link to="/admin/vinculos" className="btn btn--secondary">
            <span>Gerenciar vínculos</span>
          </Link>
        </div>
      </section>
    </div>
  );
}

import { Link } from "react-router-dom";
import { PageTitle } from "../../components/PageTitle";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { useTeacherDashboard } from "../../auth/teacherDashboardContext";
import "./TeacherPages.css";

/* /professor — Visão Geral (ordem seção 11). O dashboard já chegou pronto
   via TeacherDashboardContext (buscado uma única vez por
   RequireTeacherRole.tsx) — esta tela nunca refaz a requisição. Todo texto
   aqui é FACTUAL: nenhum "fraco"/"em risco"/"desinteressado" — só contagens
   e fatos objetivos (seção 11 da ordem). */
export function TeacherOverviewPage() {
  const dashboard = useTeacherDashboard();

  if (!dashboard) {
    // Nunca deveria acontecer (RequireTeacherRole só renderiza os filhos
    // depois de ter um dashboard válido) — estado defensivo, sem quebrar a tela.
    return <EmptyState title="Painel indisponível" description="Recarregue a página para tentar novamente." />;
  }

  const { linkedStudents, attention, recentActivityWindowDays } = dashboard;

  return (
    <div className="teacher-page">
      <PageTitle title="Visão Geral" description="Resumo factual dos alunos vinculados a você." />

      {linkedStudents.activeCount === 0 ? (
        <EmptyState
          title="Nenhum aluno vinculado ainda"
          description="Quando um vínculo for criado entre você e um aluno, ele aparecerá aqui automaticamente."
        />
      ) : (
        <>
          <section className="teacher-page__stats" aria-label="Alunos vinculados">
            <Card className="teacher-page__stat-card">
              <span className="teacher-page__stat-value">{linkedStudents.activeCount}</span>
              <span className="teacher-page__stat-label">Alunos vinculados (ativos)</span>
            </Card>
            <Card className="teacher-page__stat-card">
              <span className="teacher-page__stat-value">{linkedStudents.withRecentEvidenceCount}</span>
              <span className="teacher-page__stat-label">Com evidência nos últimos {recentActivityWindowDays} dias</span>
            </Card>
            <Card className="teacher-page__stat-card">
              <span className="teacher-page__stat-value">{linkedStudents.withoutRecentEvidenceCount}</span>
              <span className="teacher-page__stat-label">Sem atividade registrada nos últimos {recentActivityWindowDays} dias</span>
            </Card>
          </section>

          <section aria-labelledby="teacher-attention-heading">
            <h2 id="teacher-attention-heading" className="teacher-page__section-title">
              Para acompanhar
            </h2>
            {attention.length === 0 ? (
              <EmptyState
                title="Nenhum ponto de atenção no momento"
                description="Nenhum aluno vinculado tem revisão vencida, meta sem evidência recente, ausência de atividade na janela técnica ou Caderno de Erros pendente."
              />
            ) : (
              <Card>
                <ul className="teacher-page__attention-list">
                  {attention.map((item) => (
                    <li key={item.studentId} className="teacher-page__attention-item">
                      <Link to={`/professor/alunos/${item.studentId}`} className="teacher-page__attention-name">
                        {item.studentName}
                      </Link>
                      <ul className="teacher-page__attention-reasons">
                        {item.reasonLabels.map((label, index) => (
                          <li key={item.reasons[index]}>{label}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>
        </>
      )}
    </div>
  );
}

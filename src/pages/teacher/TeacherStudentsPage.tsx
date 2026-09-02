import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { PageTitle } from "../../components/PageTitle";
import { fetchTeacherStudents, type TeacherStudentListItem } from "../../api/teacherClient";
import "./TeacherPages.css";

/* /professor/alunos — Lista de Alunos (ordem seção 12). Mesmo padrão de
   src/pages/errorNotebook/ErrorNotebookListPage.tsx: filtros/ordenação/
   página vivem na URL (useSearchParams), para que recarregar preserve a
   mesma consulta; toda contagem vem da API, nunca fabricada no cliente. */

const PAGE_SIZE = 20;

const SORT_OPTIONS: Array<[string, string]> = [
  ["nome_asc", "Nome (A-Z)"],
  ["nome_desc", "Nome (Z-A)"],
  ["atividade_recente_desc", "Atividade mais recente primeiro"],
  ["revisoes_vencidas_desc", "Mais revisões vencidas primeiro"],
];

const FILTER_OPTIONS: Array<[string, string]> = [
  ["", "Todos"],
  ["com_atividade_recente", "Com atividade recente"],
  ["sem_atividade_recente", "Sem atividade recente"],
  ["com_revisao_vencida", "Com revisão vencida"],
  ["com_meta_ativa", "Com meta semanal ativa"],
  ["com_caderno_pendente", "Com entrada pendente no Caderno de Erros"],
];

function formatDate(iso: string | null): string {
  if (!iso) return "sem registro";
  const date = new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z"));
  if (Number.isNaN(date.getTime())) return "sem registro";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function StudentCard({ student }: { student: TeacherStudentListItem }) {
  return (
    <Card className="teacher-page__student-card">
      <span className="teacher-page__student-name">{student.studentName}</span>
      <span className="teacher-page__student-grade">{student.currentGrade ?? "Série não informada"}</span>
      <div className="teacher-page__student-facts">
        <span>Última atividade: {formatDate(student.lastActivityAt)}</span>
        <span>Questões recentes: {student.confirmedQuestionsRecent}</span>
        <span>Dias com atividade recente: {student.daysWithActivityRecent}</span>
        <span>Revisões vencidas: {student.overdueReviewsCount}</span>
        <span>Meta semanal ativa: {student.hasActiveWeeklyGoal ? "Sim" : "Não"}</span>
      </div>
      <Link to={`/professor/alunos/${student.studentId}`} className="btn btn--secondary">
        <span>Ver acompanhamento</span>
      </Link>
    </Card>
  );
}

export function TeacherStudentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const search = searchParams.get("busca") ?? "";
  const filter = searchParams.get("filtro") ?? "";
  const sort = searchParams.get("ordenar") ?? "nome_asc";
  const rawPage = Number(searchParams.get("pagina") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;

  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [students, setStudents] = useState<TeacherStudentListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [recentActivityWindowDays, setRecentActivityWindowDays] = useState(7);

  const hasActiveFilters = Boolean(search || filter);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const result = await fetchTeacherStudents({
        search: search || undefined,
        filter: filter || undefined,
        sort: sort || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      setStudents(result.students);
      setTotal(result.total);
      setRecentActivityWindowDays(result.recentActivityWindowDays);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, [search, filter, sort, page]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resultAnnouncement = useMemo(() => {
    if (phase !== "ready") return "";
    if (total === 0) return "Nenhum aluno encontrado.";
    const noun = total === 1 ? "aluno encontrado" : "alunos encontrados";
    return `${total} ${noun}. Página ${page} de ${totalPages}.`;
  }, [phase, total, page, totalPages]);

  function updateParams(changes: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    next.delete("pagina");
    setSearchParams(next);
  }

  function goToPage(nextPage: number) {
    const next = new URLSearchParams(searchParams);
    if (nextPage <= 1) next.delete("pagina");
    else next.set("pagina", String(nextPage));
    setSearchParams(next);
  }

  return (
    <div className="teacher-page">
      <PageTitle title="Alunos" description={`Janela técnica de atividade recente: últimos ${recentActivityWindowDays} dias.`} />

      <div className="teacher-page__filters">
        <div className="teacher-page__field">
          <label className="teacher-page__field-label" htmlFor="professor-busca">
            Buscar por nome
          </label>
          <input
            id="professor-busca"
            type="search"
            value={search}
            onChange={(event) => updateParams({ busca: event.target.value })}
            placeholder="Nome do aluno"
          />
        </div>

        <div className="teacher-page__field">
          <label className="teacher-page__field-label" htmlFor="professor-filtro">
            Filtro
          </label>
          <select id="professor-filtro" value={filter} onChange={(event) => updateParams({ filtro: event.target.value })}>
            {FILTER_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="teacher-page__field">
          <label className="teacher-page__field-label" htmlFor="professor-ordenar">
            Ordenar por
          </label>
          <select id="professor-ordenar" value={sort} onChange={(event) => updateParams({ ordenar: event.target.value })}>
            {SORT_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="teacher-page__results-count" role="status" aria-live="polite">
        {resultAnnouncement}
      </p>

      {phase === "loading" ? (
        <LoadingState label="Carregando alunos…" />
      ) : phase === "error" ? (
        <ErrorState description="Não foi possível carregar seus alunos." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />
      ) : students.length === 0 && !hasActiveFilters ? (
        <EmptyState
          title="Nenhum aluno vinculado ainda"
          description="Quando um vínculo for criado entre você e um aluno, ele aparecerá aqui automaticamente."
        />
      ) : students.length === 0 ? (
        <EmptyState
          title="Nenhum aluno encontrado com os filtros atuais"
          description="Ajuste ou limpe os filtros para ver todos os alunos vinculados a você."
          action={
            <Button variant="secondary" onClick={() => setSearchParams(new URLSearchParams())}>
              Limpar filtros
            </Button>
          }
        />
      ) : (
        <div className="teacher-page__student-grid">
          {students.map((student) => (
            <StudentCard key={student.studentId} student={student} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <nav className="teacher-page__pagination" aria-label="Paginação da lista de alunos">
          <Button type="button" variant="secondary" onClick={() => goToPage(page - 1)} disabled={page <= 1}>
            Anterior
          </Button>
          <span>
            Página {page} de {totalPages}
          </span>
          <Button type="button" variant="secondary" onClick={() => goToPage(page + 1)} disabled={page >= totalPages}>
            Próxima
          </Button>
        </nav>
      )}
    </div>
  );
}

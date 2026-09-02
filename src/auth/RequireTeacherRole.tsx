import { useEffect, useState, type ReactNode } from "react";
import { fetchTeacherDashboard, TeacherApiError, type TeacherDashboard } from "../api/teacherClient";
import { LoadingState } from "../components/LoadingState";
import { Card } from "../components/Card";
import { TeacherDashboardContext } from "./teacherDashboardContext";

/* Guard das rotas /professor/* — Sprint 14 v1.0, seção 6/10 da ordem.

   Mesmo padrão de src/auth/RequireEditorialRole.tsx: nunca confia em
   nenhum estado local, consulta o servidor a cada montagem. Como esta
   sprint não tem um endpoint dedicado só para checar o papel (ordem seção
   14: "não aumentar a API sem necessidade"), a checagem REUSA a própria
   chamada de GET /api/teacher/dashboard — 403 quer dizer "sem papel de
   professor" (ver worker/src/routes/teacher.ts), qualquer outro erro é
   tratado como falha genérica. O resultado é guardado em contexto para que
   TeacherOverviewPage não precise buscar de novo. */
export function RequireTeacherRole({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<"loading" | "denied" | "allowed" | "error">("loading");
  const [dashboard, setDashboard] = useState<TeacherDashboard | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTeacherDashboard()
      .then((result) => {
        if (cancelled) return;
        setDashboard(result.dashboard);
        setPhase("allowed");
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof TeacherApiError && error.status === 403) {
          setPhase("denied");
          return;
        }
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === "loading") return <LoadingState label="Verificando permissão de professor…" />;

  if (phase === "denied") {
    return (
      <div className="teacher teacher--centered">
        <Card className="teacher__card" role="alert">
          <h1>Acesso restrito</h1>
          <p>
            Esta área é exclusiva de contas com papel de professor. Sua conta não tem essa
            permissão — se você acredita que deveria ter acesso, fale com quem administra a
            plataforma.
          </p>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="teacher teacher--centered">
        <Card className="teacher__card" role="alert">
          <h1>Não foi possível verificar sua permissão</h1>
          <p>Tente novamente em instantes.</p>
        </Card>
      </div>
    );
  }

  return <TeacherDashboardContext.Provider value={dashboard}>{children}</TeacherDashboardContext.Provider>;
}

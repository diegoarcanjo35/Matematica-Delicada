import { useEffect, useState, type ReactNode } from "react";
import { fetchAdminDashboard, AdminApiError, type AdminDashboard } from "../api/adminClient";
import { LoadingState } from "../components/LoadingState";
import { Card } from "../components/Card";
import { AdminDashboardContext } from "./adminDashboardContext";

/* Guard das rotas /admin/* — Sprint 15 v1.0, seção 5/8 da ordem. Mesmo
   padrão de src/auth/RequireTeacherRole.tsx: nunca confia em nenhum estado
   local, consulta o servidor a cada montagem. Reusa a própria chamada de
   GET /api/admin/dashboard para checar o papel (403 = "sem papel admin",
   ver worker/src/routes/admin.ts) — nenhum endpoint dedicado só para isso
   (ordem seção 14: "não aumentar a API sem necessidade"). */
export function RequireAdminRole({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<"loading" | "denied" | "allowed" | "error">("loading");
  const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAdminDashboard()
      .then((result) => {
        if (cancelled) return;
        setDashboard(result.dashboard);
        setPhase("allowed");
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof AdminApiError && (error.status === 403 || error.status === 401)) {
          setPhase("denied");
          return;
        }
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === "loading") return <LoadingState label="Verificando permissão de administrador…" />;

  if (phase === "denied") {
    return (
      <div className="admin-page admin-page--centered">
        <Card className="admin-page__card" role="alert">
          <h1>Acesso restrito</h1>
          <p>
            Esta área é exclusiva de contas com papel de administrador. Sua conta não tem essa
            permissão — se você acredita que deveria ter acesso, fale com quem administra a
            plataforma.
          </p>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="admin-page admin-page--centered">
        <Card className="admin-page__card" role="alert">
          <h1>Não foi possível verificar sua permissão</h1>
          <p>Tente novamente em instantes.</p>
        </Card>
      </div>
    );
  }

  return <AdminDashboardContext.Provider value={dashboard}>{children}</AdminDashboardContext.Provider>;
}

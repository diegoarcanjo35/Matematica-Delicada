import { useEffect, useState, type ReactNode } from "react";
import { fetchEditorialRole, type EditorialRole } from "../api/editorialClient";
import { LoadingState } from "../components/LoadingState";
import { Card } from "../components/Card";
import { EditorialRoleContext } from "./editorialRoleContext";

/* Guard das rotas /editorial/* — Sprint 7 v1.0, seção 4.1/9 da ordem.

   Nunca confia em nenhum estado local: consulta /api/editorial/me (que por
   sua vez deriva o papel do banco a partir da sessão do servidor) a cada
   montagem. Enquanto carrega, nenhum conteúdo editorial é renderizado —
   evita qualquer "flash" de conteúdo real antes da checagem terminar. Sem
   papel editorial (editor/admin), mostra um estado de acesso negado, nunca
   um redirecionamento silencioso nem qualquer vestígio de dado editorial. */
export function RequireEditorialRole({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<"loading" | "denied" | "allowed" | "error">("loading");
  const [role, setRole] = useState<EditorialRole>(null);

  useEffect(() => {
    let cancelled = false;
    fetchEditorialRole()
      .then((result) => {
        if (cancelled) return;
        setRole(result.role);
        setPhase(result.role === "editor" || result.role === "admin" ? "allowed" : "denied");
      })
      .catch(() => {
        if (!cancelled) setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === "loading") return <LoadingState label="Verificando permissão editorial…" />;

  if (phase === "denied") {
    return (
      <div className="editorial editorial--centered">
        <Card className="editorial__card" role="alert">
          <h1>Acesso restrito</h1>
          <p>
            Esta área é exclusiva da equipe editorial. Sua conta não tem papel de editor ou
            administrador — se você acredita que deveria ter acesso, fale com quem administra a
            plataforma.
          </p>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="editorial editorial--centered">
        <Card className="editorial__card" role="alert">
          <h1>Não foi possível verificar sua permissão</h1>
          <p>Tente novamente em instantes.</p>
        </Card>
      </div>
    );
  }

  return <EditorialRoleContext.Provider value={role}>{children}</EditorialRoleContext.Provider>;
}

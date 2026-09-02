import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { Modal } from "../../components/Modal";
import { PageTitle } from "../../components/PageTitle";
import {
  ASSIGNABLE_ROLES,
  AdminApiError,
  assignAdminRole,
  fetchAdminUserDetail,
  removeAdminRole,
  type AdminUserDetail,
} from "../../api/adminClient";
import "./AdminPages.css";

/* /admin/usuarios/:userId — Detalhe do Usuário (ordem seção 11/12/20).
   Permite visualizar papéis atuais e atribuir/remover papel permitido.
   NUNCA vira um dashboard pedagógico (seção 11) — nenhuma informação além
   da identidade administrativa mínima e da contagem operacional de
   vínculos ativos quando o usuário é professor.

   Confirmação (ordem seção 20) só para remover papel — ação sensível e
   potencialmente disruptiva; atribuir um papel novo não usa modal (é
   reversível com um clique a mais na mesma tela). Após sucesso, a tela
   sempre relê o estado real do servidor (nunca atualização otimista —
   seção 20: "nunca fazer atualização otimista que possa mentir sobre
   falha de persistência"). */
export function AdminUserDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const [phase, setPhase] = useState<"loading" | "ready" | "notFound" | "error">("loading");
  const [user, setUser] = useState<AdminUserDetail | null>(null);
  const [roleToAdd, setRoleToAdd] = useState<string>("");
  const [mutating, setMutating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [roleToRemove, setRoleToRemove] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setPhase("loading");
    try {
      const result = await fetchAdminUserDetail(userId);
      setUser(result.user);
      setPhase("ready");
    } catch (error) {
      if (error instanceof AdminApiError && error.status === 404) setPhase("notFound");
      else setPhase("error");
    }
  }, [userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function handleAssign(event: React.FormEvent) {
    event.preventDefault();
    if (!userId || !roleToAdd || mutating) return;
    setMutating(true);
    setFormError(null);
    try {
      await assignAdminRole(userId, roleToAdd, crypto.randomUUID());
      setRoleToAdd("");
      await load();
    } catch (error) {
      setFormError(error instanceof AdminApiError ? error.message : "Não foi possível atribuir o papel.");
    } finally {
      setMutating(false);
    }
  }

  async function confirmRemove() {
    if (!userId || !roleToRemove || mutating) return;
    setMutating(true);
    setFormError(null);
    try {
      await removeAdminRole(userId, roleToRemove, crypto.randomUUID());
      setRoleToRemove(null);
      await load();
    } catch (error) {
      setFormError(error instanceof AdminApiError ? error.message : "Não foi possível remover o papel.");
      setRoleToRemove(null);
    } finally {
      setMutating(false);
    }
  }

  if (phase === "loading") return <LoadingState label="Carregando usuário…" />;
  if (phase === "notFound") {
    return (
      <div className="admin-page">
        <p>Usuário não encontrado.</p>
        <Link to="/admin/usuarios" className="btn btn--secondary">
          <span>Voltar para a lista</span>
        </Link>
      </div>
    );
  }
  if (phase === "error" || !user) {
    return <ErrorState description="Não foi possível carregar este usuário." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />;
  }

  const assignableOptions = ASSIGNABLE_ROLES.filter((r) => !user.roles.includes(r));

  return (
    <div className="admin-page">
      <div className="admin-page__detail-header">
        <PageTitle title={user.name} description={user.email} />
      </div>

      <Card>
        <div className="admin-page__fact-grid">
          <div className="admin-page__fact">
            <span className="admin-page__fact-value">{user.status}</span>
            <span className="admin-page__fact-label">Situação da conta</span>
          </div>
          <div className="admin-page__fact">
            <span className="admin-page__fact-value">{user.emailConfirmed ? "Confirmado" : "Não confirmado"}</span>
            <span className="admin-page__fact-label">E-mail</span>
          </div>
          {user.roles.includes("teacher") && (
            <div className="admin-page__fact">
              <span className="admin-page__fact-value">{user.activeTeacherBondsCount}</span>
              <span className="admin-page__fact-label">Vínculos ativos como professor</span>
            </div>
          )}
        </div>
      </Card>

      <section aria-labelledby="admin-user-roles-heading">
        <h2 id="admin-user-roles-heading" className="admin-page__section-title">
          Papéis
        </h2>
        <Card>
          {user.roles.length === 0 ? (
            <p>Nenhum papel atribuído no momento.</p>
          ) : (
            <ul className="admin-page__role-list">
              {user.roles.map((role) => (
                <li key={role} className="admin-page__role-row">
                  <span className="admin-page__role-chip">{role}</span>
                  <Button type="button" variant="secondary" onClick={() => setRoleToRemove(role)} disabled={mutating}>
                    Remover
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {assignableOptions.length > 0 && (
            <form className="admin-page__role-form" onSubmit={(event) => void handleAssign(event)}>
              <div className="admin-page__field">
                <label className="admin-page__field-label" htmlFor="admin-role-select">
                  Atribuir papel
                </label>
                <select id="admin-role-select" value={roleToAdd} onChange={(event) => setRoleToAdd(event.target.value)}>
                  <option value="">Selecione um papel</option>
                  {assignableOptions.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" isLoading={mutating} disabled={!roleToAdd || mutating}>
                Atribuir
              </Button>
            </form>
          )}

          {formError && (
            <p className="admin-page__form-error" role="alert">
              {formError}
            </p>
          )}
        </Card>
      </section>

      <Modal isOpen={roleToRemove !== null} title="Remover papel" onClose={() => setRoleToRemove(null)}>
        <p>
          Tem certeza de que deseja remover o papel <strong>{roleToRemove}</strong> de <strong>{user.name}</strong>?
        </p>
        <div className="admin-page__filters">
          <Button type="button" variant="secondary" onClick={() => setRoleToRemove(null)} disabled={mutating}>
            Cancelar
          </Button>
          <Button type="button" onClick={() => void confirmRemove()} isLoading={mutating}>
            Confirmar remoção
          </Button>
        </div>
      </Modal>
    </div>
  );
}

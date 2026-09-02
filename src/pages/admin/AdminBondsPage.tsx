import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { Modal } from "../../components/Modal";
import { PageTitle } from "../../components/PageTitle";
import {
  AdminApiError,
  createAdminBond,
  deactivateAdminBond,
  fetchAdminBonds,
  reactivateAdminBond,
  type AdminBond,
} from "../../api/adminClient";
import "./AdminPages.css";

/* /admin/vinculos — Gestão de Vínculos Professor <-> Aluno (ordem seção
   13/20). Criar/reativar/inativar — nunca DELETE (par único
   teacher_id/student_id da migration 0019: reativação é sempre UPDATE na
   mesma linha, nunca uma segunda linha para o mesmo par).

   Confirmação (ordem seção 20) só para inativar — ação sensível que
   remove acesso do professor aos dados do aluno. Criar/reativar não usa
   modal (efeito é sempre "conceder/restaurar acesso", nunca destrutivo). */

const PAGE_SIZE = 20;

const STATUS_OPTIONS: Array<[string, string]> = [
  ["", "Todos"],
  ["active", "Ativos"],
  ["inactive", "Inativos"],
];

function formatDate(iso: string | null): string {
  if (!iso) return "sem registro";
  const date = new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z"));
  if (Number.isNaN(date.getTime())) return "sem registro";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function AdminBondsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get("busca") ?? "";
  const status = (searchParams.get("situacao") ?? "") as "" | "active" | "inactive";
  const rawPage = Number(searchParams.get("pagina") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;

  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [bonds, setBonds] = useState<AdminBond[]>([]);
  const [total, setTotal] = useState(0);

  const [teacherId, setTeacherId] = useState("");
  const [studentId, setStudentId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [mutatingBondId, setMutatingBondId] = useState<string | null>(null);
  const [bondToDeactivate, setBondToDeactivate] = useState<AdminBond | null>(null);

  const hasActiveFilters = Boolean(search || status);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const result = await fetchAdminBonds({ search: search || undefined, status: status || undefined, page, pageSize: PAGE_SIZE });
      setBonds(result.bonds);
      setTotal(result.total);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, [search, status, page]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resultAnnouncement = useMemo(() => {
    if (phase !== "ready") return "";
    if (total === 0) return "Nenhum vínculo encontrado.";
    const noun = total === 1 ? "vínculo encontrado" : "vínculos encontrados";
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

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!teacherId.trim() || !studentId.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      await createAdminBond(teacherId.trim(), studentId.trim(), crypto.randomUUID());
      setTeacherId("");
      setStudentId("");
      await load();
    } catch (error) {
      setCreateError(error instanceof AdminApiError ? error.message : "Não foi possível criar o vínculo.");
    } finally {
      setCreating(false);
    }
  }

  async function handleReactivate(bond: AdminBond) {
    if (mutatingBondId) return;
    setMutatingBondId(bond.id);
    try {
      await reactivateAdminBond(bond.id, crypto.randomUUID());
      await load();
    } finally {
      setMutatingBondId(null);
    }
  }

  async function confirmDeactivate() {
    if (!bondToDeactivate || mutatingBondId) return;
    setMutatingBondId(bondToDeactivate.id);
    try {
      await deactivateAdminBond(bondToDeactivate.id, crypto.randomUUID());
      setBondToDeactivate(null);
      await load();
    } finally {
      setMutatingBondId(null);
    }
  }

  return (
    <div className="admin-page">
      <PageTitle title="Vínculos Professor-Aluno" description="Criar, reativar e inativar vínculos entre professores e alunos." />

      <section aria-labelledby="admin-bond-create-heading">
        <h2 id="admin-bond-create-heading" className="admin-page__section-title">
          Criar novo vínculo
        </h2>
        <form className="admin-page__create-bond-form" onSubmit={(event) => void handleCreate(event)}>
          <div className="admin-page__field">
            <label className="admin-page__field-label" htmlFor="admin-bond-teacher">
              ID do professor
            </label>
            <input id="admin-bond-teacher" value={teacherId} onChange={(event) => setTeacherId(event.target.value)} placeholder="ID do professor" />
          </div>
          <div className="admin-page__field">
            <label className="admin-page__field-label" htmlFor="admin-bond-student">
              ID do aluno
            </label>
            <input id="admin-bond-student" value={studentId} onChange={(event) => setStudentId(event.target.value)} placeholder="ID do aluno" />
          </div>
          <Button type="submit" isLoading={creating} disabled={!teacherId.trim() || !studentId.trim() || creating}>
            Criar vínculo
          </Button>
        </form>
        {createError && (
          <p className="admin-page__form-error" role="alert">
            {createError}
          </p>
        )}
        <p className="admin-page__results-count">
          Localize os IDs em <a href="/admin/usuarios">Usuários</a> — o professor precisa já ter o papel <strong>teacher</strong>.
        </p>
      </section>

      <section aria-labelledby="admin-bond-list-heading">
        <h2 id="admin-bond-list-heading" className="admin-page__section-title">
          Vínculos existentes
        </h2>

        <div className="admin-page__filters">
          <div className="admin-page__field">
            <label className="admin-page__field-label" htmlFor="admin-bond-busca">
              Buscar por nome do professor ou do aluno
            </label>
            <input id="admin-bond-busca" type="search" value={search} onChange={(event) => updateParams({ busca: event.target.value })} />
          </div>
          <div className="admin-page__field">
            <label className="admin-page__field-label" htmlFor="admin-bond-situacao">
              Situação
            </label>
            <select id="admin-bond-situacao" value={status} onChange={(event) => updateParams({ situacao: event.target.value })}>
              {STATUS_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p className="admin-page__results-count" role="status" aria-live="polite">
          {resultAnnouncement}
        </p>

        {phase === "loading" ? (
          <LoadingState label="Carregando vínculos…" />
        ) : phase === "error" ? (
          <ErrorState description="Não foi possível carregar os vínculos." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />
        ) : bonds.length === 0 && !hasActiveFilters ? (
          <EmptyState title="Nenhum vínculo cadastrado ainda" description="Crie o primeiro vínculo usando o formulário acima." />
        ) : bonds.length === 0 ? (
          <EmptyState
            title="Nenhum vínculo encontrado com os filtros atuais"
            action={
              <Button variant="secondary" onClick={() => setSearchParams(new URLSearchParams())}>
                Limpar filtros
              </Button>
            }
          />
        ) : (
          <div className="admin-page__table-wrap">
            <table className="admin-page__table">
              <thead>
                <tr>
                  <th scope="col">Professor</th>
                  <th scope="col">Aluno</th>
                  <th scope="col">Situação</th>
                  <th scope="col">Atualizado em</th>
                  <th scope="col">
                    <span className="admin-page__sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {bonds.map((bond) => (
                  <tr key={bond.id}>
                    <td>{bond.teacherName}</td>
                    <td>{bond.studentName}</td>
                    <td>
                      <span className={`admin-page__status-badge admin-page__status-badge--${bond.status}`}>
                        {bond.status === "active" ? "Ativo" : "Inativo"}
                      </span>
                    </td>
                    <td>{formatDate(bond.updatedAt)}</td>
                    <td>
                      {bond.status === "active" ? (
                        <Button type="button" variant="secondary" onClick={() => setBondToDeactivate(bond)} disabled={mutatingBondId !== null}>
                          Inativar
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => void handleReactivate(bond)}
                          isLoading={mutatingBondId === bond.id}
                          disabled={mutatingBondId !== null}
                        >
                          Reativar
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <nav className="admin-page__pagination" aria-label="Paginação da lista de vínculos">
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
      </section>

      <Modal isOpen={bondToDeactivate !== null} title="Inativar vínculo" onClose={() => setBondToDeactivate(null)}>
        <p>
          Tem certeza de que deseja inativar o vínculo entre <strong>{bondToDeactivate?.teacherName}</strong> e{" "}
          <strong>{bondToDeactivate?.studentName}</strong>? O professor perderá acesso aos dados deste aluno até que o vínculo seja reativado.
        </p>
        <div className="admin-page__filters">
          <Button type="button" variant="secondary" onClick={() => setBondToDeactivate(null)} disabled={mutatingBondId !== null}>
            Cancelar
          </Button>
          <Button type="button" onClick={() => void confirmDeactivate()} isLoading={mutatingBondId !== null}>
            Confirmar inativação
          </Button>
        </div>
      </Modal>
    </div>
  );
}

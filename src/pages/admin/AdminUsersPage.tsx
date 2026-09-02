import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { PageTitle } from "../../components/PageTitle";
import { fetchAdminUsers, type AdminUserListItem } from "../../api/adminClient";
import "./AdminPages.css";

/* /admin/usuarios — Listagem de Usuários (ordem seção 10). Mesmo padrão de
   src/pages/teacher/TeacherStudentsPage.tsx: filtros/ordenação/página
   vivem na URL (useSearchParams), toda contagem vem da API. */

const PAGE_SIZE = 20;

const ROLE_OPTIONS: Array<[string, string]> = [
  ["", "Todos os papéis"],
  ["sem_papel", "Sem papel"],
  ["student", "student"],
  ["teacher", "teacher"],
  ["editor", "editor"],
  ["admin", "admin"],
  ["support", "support"],
  ["commercial", "commercial"],
];

const SORT_OPTIONS: Array<[string, string]> = [
  ["nome_asc", "Nome (A-Z)"],
  ["nome_desc", "Nome (Z-A)"],
  ["criado_recente", "Cadastro mais recente"],
  ["criado_antigo", "Cadastro mais antigo"],
];

function formatDate(iso: string | null): string {
  if (!iso) return "sem registro";
  const date = new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z"));
  if (Number.isNaN(date.getTime())) return "sem registro";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function AdminUsersPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const search = searchParams.get("busca") ?? "";
  const role = searchParams.get("papel") ?? "";
  const sort = searchParams.get("ordenar") ?? "nome_asc";
  const rawPage = Number(searchParams.get("pagina") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;

  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [users, setUsers] = useState<AdminUserListItem[]>([]);
  const [total, setTotal] = useState(0);

  const hasActiveFilters = Boolean(search || role);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const result = await fetchAdminUsers({ search: search || undefined, role: role || undefined, sort: sort || undefined, page, pageSize: PAGE_SIZE });
      setUsers(result.users);
      setTotal(result.total);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, [search, role, sort, page]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resultAnnouncement = useMemo(() => {
    if (phase !== "ready") return "";
    if (total === 0) return "Nenhum usuário encontrado.";
    const noun = total === 1 ? "usuário encontrado" : "usuários encontrados";
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
    <div className="admin-page">
      <PageTitle title="Usuários" description="Buscar, filtrar e visualizar contas da plataforma." />

      <div className="admin-page__filters">
        <div className="admin-page__field">
          <label className="admin-page__field-label" htmlFor="admin-busca">
            Buscar por nome ou e-mail
          </label>
          <input id="admin-busca" type="search" value={search} onChange={(event) => updateParams({ busca: event.target.value })} placeholder="Nome ou e-mail" />
        </div>

        <div className="admin-page__field">
          <label className="admin-page__field-label" htmlFor="admin-papel">
            Papel
          </label>
          <select id="admin-papel" value={role} onChange={(event) => updateParams({ papel: event.target.value })}>
            {ROLE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="admin-page__field">
          <label className="admin-page__field-label" htmlFor="admin-ordenar">
            Ordenar por
          </label>
          <select id="admin-ordenar" value={sort} onChange={(event) => updateParams({ ordenar: event.target.value })}>
            {SORT_OPTIONS.map(([value, label]) => (
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
        <LoadingState label="Carregando usuários…" />
      ) : phase === "error" ? (
        <ErrorState description="Não foi possível carregar os usuários." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />
      ) : users.length === 0 && !hasActiveFilters ? (
        <EmptyState title="Nenhum usuário cadastrado ainda" />
      ) : users.length === 0 ? (
        <EmptyState
          title="Nenhum usuário encontrado com os filtros atuais"
          description="Ajuste ou limpe os filtros para ver todos os usuários."
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
                <th scope="col">Nome</th>
                <th scope="col">E-mail</th>
                <th scope="col">Papéis</th>
                <th scope="col">Situação</th>
                <th scope="col">Criado em</th>
                <th scope="col">
                  <span className="admin-page__sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.name}</td>
                  <td>{user.email}</td>
                  <td>
                    {user.roles.length === 0 ? (
                      <span className="admin-page__role-chip">sem papel</span>
                    ) : (
                      <span className="admin-page__role-chip-list">
                        {user.roles.map((r) => (
                          <span key={r} className="admin-page__role-chip">
                            {r}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td>{user.status}</td>
                  <td>{formatDate(user.createdAt)}</td>
                  <td>
                    <Link to={`/admin/usuarios/${user.id}`} className="btn btn--secondary">
                      <span>Ver detalhe</span>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <nav className="admin-page__pagination" aria-label="Paginação da lista de usuários">
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

import type { Env } from "../env";
import { Errors, json } from "../lib/response";
import { readSessionToken } from "../lib/cookies";
import { checkSession } from "../services/authService";
import { getDashboard, getStudentDetail, listStudents } from "../services/teacherService";

/* Rotas do Painel do Professor — Sprint 14 v1.0.

   TODAS somente leitura (ordem seção 14): nenhuma destas rotas cria
   vínculo, cria snapshot, cria meta, cria evento de auditoria, altera
   last_seen ou escreve qualquer cache — cada handler só chama funções de
   leitura de teacherService.ts, que por sua vez só chamam serviços de
   leitura já existentes das Sprints 10-13. Por isso, ao contrário de
   worker/src/routes/weeklyReview.ts (que audita mutações), este arquivo
   nunca importa recordAuditEvent.

   Autorização (ordem seção 6), sempre nesta ordem:
     1) sessão válida (401 se ausente/inválida);
     2) papel `teacher` da sessão — SEM ISSO, /dashboard e /students
        respondem 403 (área do próprio professor, sem ID de recurso
        alheio — nenhum risco de enumeração em negar com 403 aqui, mesmo
        padrão de Errors.forbidden() já usado no restante do projeto para
        gates de permissão sem recurso específico);
     3) para /students/:studentId — vínculo ATIVO teacher_student_access
        para EXATAMENTE este par. Papel ausente, vínculo inexistente e
        vínculo inativo respondem TODOS 404 idêntico (nunca 403 aqui) —
        um aluno de outro professor, ou nenhum professor, deve parecer
        inexistente (seção 6/17: "evitar enumeração"). `teacherId` vem
        SEMPRE da sessão (nunca do cliente); `studentId` vem SEMPRE do
        path, nunca aceito como parte do corpo/query para reautorizar. */

async function requireUser(request: Request, env: Env): Promise<{ id: string } | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const result = await checkSession(env.DB, token);
  if (!result.ok || !result.user) return null;
  return { id: result.user.id };
}

const STUDENT_DETAIL_RE = /^\/api\/teacher\/students\/([^/]+)$/;

export async function handleTeacherRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith("/api/teacher/")) return null;

  const method = request.method;
  const user = await requireUser(request, env);
  if (!user) return Errors.unauthorized();

  if (path === "/api/teacher/dashboard") {
    if (method !== "GET") return Errors.methodNotAllowed();
    const result = await getDashboard(env.DB, user.id);
    if (!result.ok) return Errors.forbidden("Esta área é exclusiva de contas com papel de professor.");
    return json({ ok: true, dashboard: result.dashboard });
  }

  if (path === "/api/teacher/students") {
    if (method !== "GET") return Errors.methodNotAllowed();
    const result = await listStudents(env.DB, user.id, {
      search: url.searchParams.get("busca"),
      filter: url.searchParams.get("filtro"),
      sort: url.searchParams.get("ordenar"),
      page: parsePositiveIntOrNull(url.searchParams.get("pagina")),
      pageSize: parsePositiveIntOrNull(url.searchParams.get("tamanho")),
    });
    if (!result.ok) return Errors.forbidden("Esta área é exclusiva de contas com papel de professor.");
    return json({
      ok: true,
      students: result.students,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      recentActivityWindowDays: result.recentActivityWindowDays,
    });
  }

  const studentMatch = path.match(STUDENT_DETAIL_RE);
  if (studentMatch) {
    if (method !== "GET") return Errors.methodNotAllowed();
    const studentId = decodeURIComponent(studentMatch[1]);
    const result = await getStudentDetail(env.DB, user.id, studentId);
    if (!result.ok) return Errors.notFound();
    return json({ ok: true, detail: result.detail });
  }

  return null;
}

function parsePositiveIntOrNull(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

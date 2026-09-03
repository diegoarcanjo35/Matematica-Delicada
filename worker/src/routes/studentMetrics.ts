import type { Env } from "../env";
import { Errors, json } from "../lib/response";
import { readSessionToken } from "../lib/cookies";
import { checkSession } from "../services/authService";
import { getPatternMetricDetail, getRecentActivity, getStudentMetricsSummary, listPatternMetrics } from "../services/studentMetricsService";
import { isQuestionBankAvailable } from "../repositories/questionRepository";

/* Rotas do Mapa ENEM do Aluno — Sprint 10 v1.0.

   Só 4 dos 5 endpoints possíveis da seção 8 da ordem foram implementados:
   `GET /summary`, `GET /patterns`, `GET /patterns/:slug`, `GET /activity`.
   `POST /rebuild` NÃO existe nesta sprint — não há projeção persistida
   para reconstruir (ver migrations/0015_student_metrics_map.sql e
   docs/METRICAS_MAPA_ENEM.md). Toda rota aqui é GET e SOMENTE LEITURA:
   nenhuma delas grava nada, nenhuma delas audita nada (seção 13 da ordem:
   "GET nunca audita" — não há mutação real para auditar aqui).

   Mesma ordem obrigatória de checagens do resto do namespace do aluno
   (Player, Caderno de Erros): 1) sessão válida (401); 2) disponibilidade
   do módulo — Sprint 16 v1.2 (correção do bloqueador remanescente da
   v1.1): `isQuestionBankAvailable` (questionRepository.ts) substitui
   `isLocalEditorialFixturesAllowed`, migrando o Mapa ENEM para o MESMO
   critério já aplicado a Player/Treino Diário/Simulados/Caderno de Erros
   desde a v1.1 — disponível em dev local com fixtures explicitamente
   habilitadas, OU em qualquer outro ambiente (produção real inclusive)
   quando existir ao menos uma questão REAL publicada; 3) validação de
   parâmetros; 4) só então o serviço consulta o banco. `userId` vem SEMPRE
   da sessão — nunca de
   query/body/path (seção 8: "user_id sempre da sessão, nunca do
   corpo/query/path"). Um padrão de outro aluno nunca é exposto porque
   toda consulta já é escopada por `user_id` no repositório — um slug
   inexistente/não publicado responde 404 igual ao catálogo de padrões
   (Sprint 6), nunca 403 (mesmo padrão "404, não 403" do resto do
   projeto). */

async function requireUser(request: Request, env: Env): Promise<{ id: string } | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const result = await checkSession(env.DB, token);
  if (!result.ok || !result.user) return null;
  return { id: result.user.id };
}

function unavailableResponse(): Response {
  return json({ ok: true, available: false, message: "O Mapa ENEM está em preparação." }, { status: 200 });
}

const PATTERN_DETAIL_RE = /^\/api\/student-metrics\/patterns\/([^/]+)$/;

export async function handleStudentMetricsRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith("/api/student-metrics")) return null;

  const user = await requireUser(request, env);
  if (!user) return Errors.unauthorized();

  const available = await isQuestionBankAvailable(env, url, env.DB);
  if (!available) return unavailableResponse();

  if (path === "/api/student-metrics/summary") {
    if (method !== "GET") return Errors.methodNotAllowed();
    const summary = await getStudentMetricsSummary(env.DB, user.id);
    return json({ ok: true, summary });
  }

  if (path === "/api/student-metrics/patterns") {
    if (method !== "GET") return Errors.methodNotAllowed();
    const patterns = await listPatternMetrics(env.DB, user.id);
    return json({ ok: true, patterns });
  }

  if (path === "/api/student-metrics/activity") {
    if (method !== "GET") return Errors.methodNotAllowed();
    const activity = await getRecentActivity(env.DB, user.id);
    return json({ ok: true, activity });
  }

  const detailMatch = path.match(PATTERN_DETAIL_RE);
  if (detailMatch) {
    if (method !== "GET") return Errors.methodNotAllowed();
    const slug = decodeURIComponent(detailMatch[1]);
    const detail = await getPatternMetricDetail(env.DB, user.id, slug);
    if (!detail) return Errors.notFound();
    return json({ ok: true, pattern: detail });
  }

  return Errors.notFound();
}

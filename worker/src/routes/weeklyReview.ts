import type { Env } from "../env";
import { Errors, json, readJsonBody } from "../lib/response";
import { readSessionToken } from "../lib/cookies";
import { checkSession } from "../services/authService";
import { recordAuditEvent, type AuditEventType } from "../repositories/auditRepository";
import { abandonGoal, applyGoal, completeGoal, getHistory, getReportForWeek, patchGoal, previewGoal } from "../services/weeklyReviewService";

/* Rotas do Relatório Semanal e das Metas Realistas — Sprint 13 v1.0.

   Mesma ordem obrigatória de checagens do resto do namespace do aluno desde
   as Sprints 8-12: 1) sessão válida (401); 2) validação de parâmetros;
   3) só então o serviço consulta/muta o banco.

   Um recurso (meta) de outro aluno SEMPRE responde 404 (nunca 403) — os
   repositórios já escopam por user_id no SQL.

   GETs (current/history/:weekStart/preview) são estritamente somente
   leitura (seção 7/10 da ordem: "leitura do relatório e preview não geram
   auditoria") — nunca chamam nenhuma função que grava no banco, e por isso
   NUNCA auditam. */

function newId(): string {
  return crypto.randomUUID();
}

async function audit(env: Env, type: AuditEventType, userId: string, metadata?: Record<string, string | number | boolean>) {
  await recordAuditEvent(env.DB, newId(), type, userId, metadata);
}

async function requireUser(request: Request, env: Env): Promise<{ id: string } | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const result = await checkSession(env.DB, token);
  if (!result.ok || !result.user) return null;
  return { id: result.user.id };
}

function conflictResponse(): Response {
  return Errors.conflict("Esta meta foi alterada em outro lugar. Recarregue e tente novamente.");
}

function fieldErrorResponse(message: string, fields?: Record<string, string>): Response {
  return json({ error: { code: "validation_error", message, fields } }, { status: 400 });
}

function readMutationId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>).mutationId;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const GOAL_PATCH_RE = /^\/api\/weekly-goals\/([^/]+)$/;
const GOAL_COMPLETE_RE = /^\/api\/weekly-goals\/([^/]+)\/complete$/;
const GOAL_ABANDON_RE = /^\/api\/weekly-goals\/([^/]+)\/abandon$/;
const GOAL_RESERVED_IDS = new Set(["preview", "apply"]);
const REVIEW_WEEK_RE = /^\/api\/weekly-review\/([^/]+)$/;
const REVIEW_RESERVED_IDS = new Set(["current", "history"]);

export async function handleWeeklyReviewRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (path.startsWith("/api/weekly-review")) {
    const user = await requireUser(request, env);
    if (!user) return Errors.unauthorized();

    if (path === "/api/weekly-review/current") {
      if (method !== "GET") return Errors.methodNotAllowed();
      const result = await getReportForWeek(env.DB, user.id, undefined);
      if (!result.ok) return fieldErrorResponse("Não foi possível carregar o relatório semanal.", result.fieldErrors);
      return json({ ok: true, report: result.report });
    }

    if (path === "/api/weekly-review/history") {
      if (method !== "GET") return Errors.methodNotAllowed();
      const result = await getHistory(env.DB, user.id);
      return json({ ok: true, weeks: result.weeks });
    }

    const weekMatch = path.match(REVIEW_WEEK_RE);
    if (weekMatch && !REVIEW_RESERVED_IDS.has(weekMatch[1])) {
      if (method !== "GET") return Errors.methodNotAllowed();
      const result = await getReportForWeek(env.DB, user.id, decodeURIComponent(weekMatch[1]));
      if (!result.ok) return fieldErrorResponse("Não foi possível carregar o relatório desta semana.", result.fieldErrors);
      return json({ ok: true, report: result.report });
    }

    return null;
  }

  if (path.startsWith("/api/weekly-goals")) {
    const user = await requireUser(request, env);
    if (!user) return Errors.unauthorized();

    if (path === "/api/weekly-goals/preview") {
      if (method !== "GET") return Errors.methodNotAllowed();
      const result = await previewGoal(env.DB, user.id, url.searchParams.get("weekStart"));
      if (!result.ok) return fieldErrorResponse("Não foi possível montar a sugestão de meta.", result.fieldErrors);
      return json({ ok: true, preview: result.preview });
    }

    if (path === "/api/weekly-goals/apply") {
      if (method !== "POST") return Errors.methodNotAllowed();
      const body = await readJsonBody<{
        mutationId?: unknown;
        weekStart?: unknown;
        targetMinutes?: unknown;
        targetQuestions?: unknown;
        availableDays?: unknown;
        patternIds?: unknown;
      }>(request);
      const mutationId = readMutationId(body);
      if (!mutationId) return fieldErrorResponse("mutationId é obrigatório.", { mutationId: "mutationId é obrigatório." });
      const result = await applyGoal(env.DB, user.id, {
        mutationId,
        weekStart: body?.weekStart,
        targetMinutes: body?.targetMinutes,
        targetQuestions: body?.targetQuestions,
        availableDays: body?.availableDays,
        patternIds: body?.patternIds,
      });
      if (!result.ok) {
        if (result.notFound) return Errors.notFound();
        if (result.conflict) return conflictResponse();
        if (result.activeElsewhere) return fieldErrorResponse("Você já tem uma meta ativa para esta semana.", result.fieldErrors);
        return fieldErrorResponse("Não foi possível aplicar a meta.", result.fieldErrors);
      }
      if (result.changed) await audit(env, "weekly_goal_created", user.id, { goalId: result.value!.goalId });
      return json({ ok: true, goalId: result.value!.goalId });
    }

    const completeMatch = path.match(GOAL_COMPLETE_RE);
    if (completeMatch) {
      if (method !== "POST") return Errors.methodNotAllowed();
      const goalId = completeMatch[1];
      const body = await readJsonBody<{ mutationId?: unknown }>(request);
      const mutationId = readMutationId(body);
      if (!mutationId) return fieldErrorResponse("mutationId é obrigatório.", { mutationId: "mutationId é obrigatório." });
      const result = await completeGoal(env.DB, user.id, goalId, mutationId);
      if (!result.ok) {
        if (result.notFound) return Errors.notFound();
        if (result.conflict) return conflictResponse();
        return fieldErrorResponse("Não foi possível concluir esta meta.", result.fieldErrors);
      }
      if (result.changed) await audit(env, "weekly_goal_completed", user.id, { goalId });
      return json({ ok: true });
    }

    const abandonMatch = path.match(GOAL_ABANDON_RE);
    if (abandonMatch) {
      if (method !== "POST") return Errors.methodNotAllowed();
      const goalId = abandonMatch[1];
      const body = await readJsonBody<{ mutationId?: unknown }>(request);
      const mutationId = readMutationId(body);
      if (!mutationId) return fieldErrorResponse("mutationId é obrigatório.", { mutationId: "mutationId é obrigatório." });
      const result = await abandonGoal(env.DB, user.id, goalId, mutationId);
      if (!result.ok) {
        if (result.notFound) return Errors.notFound();
        if (result.conflict) return conflictResponse();
        return fieldErrorResponse("Não foi possível abandonar esta meta.", result.fieldErrors);
      }
      if (result.changed) await audit(env, "weekly_goal_abandoned", user.id, { goalId });
      return json({ ok: true });
    }

    const patchMatch = path.match(GOAL_PATCH_RE);
    if (patchMatch && !GOAL_RESERVED_IDS.has(patchMatch[1])) {
      if (method !== "PATCH") return Errors.methodNotAllowed();
      const goalId = patchMatch[1];
      const body = await readJsonBody<{
        mutationId?: unknown;
        version?: unknown;
        targetMinutes?: unknown;
        targetQuestions?: unknown;
        availableDays?: unknown;
        patternIds?: unknown;
      }>(request);
      const mutationId = readMutationId(body);
      if (!mutationId) return fieldErrorResponse("mutationId é obrigatório.", { mutationId: "mutationId é obrigatório." });
      const result = await patchGoal(env.DB, user.id, goalId, {
        mutationId,
        version: body?.version,
        targetMinutes: body?.targetMinutes,
        targetQuestions: body?.targetQuestions,
        availableDays: body?.availableDays,
        patternIds: body?.patternIds,
      });
      if (!result.ok) {
        if (result.notFound) return Errors.notFound();
        if (result.conflict) return conflictResponse();
        return fieldErrorResponse("Não foi possível atualizar esta meta.", result.fieldErrors);
      }
      if (result.changed) await audit(env, "weekly_goal_updated", user.id, { goalId });
      return json({ ok: true, goal: result.value!.goal });
    }

    return null;
  }

  return null;
}

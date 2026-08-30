import type { Env } from "../env";
import { isLocalScheduleFixturesAllowed } from "../env";
import { Errors, json, readJsonBody } from "../lib/response";
import { readSessionToken } from "../lib/cookies";
import { checkSession } from "../services/authService";
import { recordAuditEvent, type AuditEventType } from "../repositories/auditRepository";
import { isValidTimezone, validateBlockReason, validateVersion, validateView } from "../lib/scheduleValidation";
import {
  applyPlan,
  blockAssignment,
  completeAssignment,
  dismissAssignment,
  getActivitiesView,
  getAssignmentDetail,
  getSummary,
  previewPlan,
  rescheduleAssignment,
  setTimezone,
  startAssignment,
  systemClock,
  type ScheduleView,
} from "../services/scheduleService";

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

function unavailableResponse() {
  return json({ ok: true, available: false, message: "O cronograma está em preparação." }, { status: 200 });
}

const ASSIGNMENT_ID_RE = /^\/api\/schedule\/activities\/([^/]+)$/;
const START_RE = /^\/api\/schedule\/activities\/([^/]+)\/start$/;
const COMPLETE_RE = /^\/api\/schedule\/activities\/([^/]+)\/complete$/;
const DISMISS_RE = /^\/api\/schedule\/activities\/([^/]+)\/dismiss$/;
const BLOCK_RE = /^\/api\/schedule\/activities\/([^/]+)\/block$/;
const RESCHEDULE_RE = /^\/api\/schedule\/activities\/([^/]+)\/reschedule$/;

export async function handleScheduleRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith("/api/schedule")) return null;

  const user = await requireUser(request, env);
  if (!user) return Errors.unauthorized();

  const fixturesAllowed = isLocalScheduleFixturesAllowed(env, url);

  if (path === "/api/schedule/summary" && method === "GET") {
    const summary = await getSummary(env.DB, user.id, fixturesAllowed, systemClock);
    return json({ ok: true, ...summary });
  }

  if (!fixturesAllowed) {
    return unavailableResponse();
  }

  if (path === "/api/schedule/activities" && method === "GET") {
    const viewParam = url.searchParams.get("view") ?? "today";
    const viewResult = validateView(viewParam);
    if (!viewResult.ok) return Errors.badRequest(viewResult.error ?? "Visão inválida.");
    const yearParam = url.searchParams.get("year");
    const monthParam = url.searchParams.get("month");
    const activities = await getActivitiesView(env.DB, user.id, viewResult.value as ScheduleView, systemClock, {
      year: yearParam ? Number(yearParam) : undefined,
      month: monthParam ? Number(monthParam) : undefined,
    });
    return json({ ok: true, activities });
  }

  if (path === "/api/schedule/preferences" && method === "PATCH") {
    const body = await readJsonBody<{ timezone?: unknown }>(request);
    if (!body || typeof body.timezone !== "string" || !isValidTimezone(body.timezone)) {
      return json(
        { error: { code: "validation_error", message: "Fuso horário inválido.", fields: { timezone: "Fuso horário inválido ou não suportado." } } },
        { status: 400 }
      );
    }
    await setTimezone(env.DB, user.id, body.timezone);
    return json({ ok: true, timezone: body.timezone });
  }

  const assignmentIdMatch = path.match(ASSIGNMENT_ID_RE);
  if (assignmentIdMatch && method === "GET") {
    const detail = await getAssignmentDetail(env.DB, user.id, assignmentIdMatch[1], systemClock);
    if (!detail) return Errors.notFound();
    return json({ ok: true, activity: detail });
  }

  async function readVersion(): Promise<{ ok: true; version: number } | { ok: false; response: Response }> {
    const body = await readJsonBody<{ version?: unknown }>(request);
    const versionResult = validateVersion(body?.version);
    if (!versionResult.ok) {
      return {
        ok: false,
        response: json(
          { error: { code: "validation_error", message: "Versão inválida.", fields: { version: versionResult.error } } },
          { status: 400 }
        ),
      };
    }
    return { ok: true, version: versionResult.value! };
  }

  const startMatch = path.match(START_RE);
  if (startMatch && method === "POST") {
    const versionResult = await readVersion();
    if (!versionResult.ok) return versionResult.response;
    const result = await startAssignment(env.DB, user.id, startMatch[1], versionResult.version);
    if (!result.ok) return transitionErrorResponse(result);
    // Correção v1.2 — só audita quando houve mutação real, nunca numa
    // repetição idempotente.
    if (result.changed) {
      await audit(env, "schedule_activity_started", user.id, { assignmentId: startMatch[1] });
    }
    return json({ ok: true });
  }

  const completeMatch = path.match(COMPLETE_RE);
  if (completeMatch && method === "POST") {
    const versionResult = await readVersion();
    if (!versionResult.ok) return versionResult.response;
    const result = await completeAssignment(env.DB, user.id, completeMatch[1], versionResult.version);
    if (!result.ok) return transitionErrorResponse(result);
    if (result.changed) {
      await audit(env, "schedule_activity_completed", user.id, { assignmentId: completeMatch[1] });
    }
    return json({ ok: true });
  }

  const dismissMatch = path.match(DISMISS_RE);
  if (dismissMatch && method === "POST") {
    const versionResult = await readVersion();
    if (!versionResult.ok) return versionResult.response;
    const result = await dismissAssignment(env.DB, user.id, dismissMatch[1], versionResult.version);
    if (!result.ok) return transitionErrorResponse(result);
    if (result.changed) {
      await audit(env, "schedule_activity_dismissed", user.id, { assignmentId: dismissMatch[1] });
    }
    return json({ ok: true });
  }

  const blockMatch = path.match(BLOCK_RE);
  if (blockMatch && method === "POST") {
    const body = await readJsonBody<{ version?: unknown; reason?: unknown }>(request);
    const versionResult = validateVersion(body?.version);
    if (!versionResult.ok) {
      return json(
        { error: { code: "validation_error", message: "Versão inválida.", fields: { version: versionResult.error! } } },
        { status: 400 }
      );
    }
    const reasonResult = validateBlockReason(body?.reason);
    if (!reasonResult.ok) {
      return json(
        { error: { code: "validation_error", message: "Motivo inválido.", fields: { reason: reasonResult.error! } } },
        { status: 400 }
      );
    }
    const result = await blockAssignment(env.DB, user.id, blockMatch[1], versionResult.value!, reasonResult.value!);
    if (!result.ok) return transitionErrorResponse(result);
    if (result.changed) {
      await audit(env, "schedule_activity_blocked", user.id, { assignmentId: blockMatch[1], reason: reasonResult.value! });
    }
    return json({ ok: true });
  }

  const rescheduleMatch = path.match(RESCHEDULE_RE);
  if (rescheduleMatch && method === "POST") {
    const versionResult = await readVersion();
    if (!versionResult.ok) return versionResult.response;
    const result = await rescheduleAssignment(env.DB, user.id, rescheduleMatch[1], versionResult.version, systemClock);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) {
        return json({ error: { code: "conflict", message: "Esta atividade foi alterada por outra requisição." } }, { status: 409 });
      }
      if (result.reason === "no_capacity") {
        await audit(env, "schedule_conflict_detected", user.id, { assignmentId: rescheduleMatch[1], reason: "no_capacity" });
        return json(
          { error: { code: "no_capacity", message: "Não há capacidade disponível no horizonte técnico para reagendar." } },
          { status: 409 }
        );
      }
      return Errors.badRequest("Não foi possível reagendar esta atividade.");
    }
    await audit(env, "schedule_activity_rescheduled", user.id, {
      assignmentId: rescheduleMatch[1],
      newAssignmentId: result.newAssignmentId!,
    });
    return json({ ok: true, newAssignmentId: result.newAssignmentId });
  }

  if (path === "/api/schedule/plan/preview" && method === "POST") {
    const preview = await previewPlan(env.DB, user.id, systemClock);
    await audit(env, "schedule_plan_previewed", user.id, {
      placedCount: preview.placed.length,
      unplaceableCount: preview.unplaceableAssignmentIds.length,
    });
    return json({ ok: true, ...preview });
  }

  if (path === "/api/schedule/plan/apply" && method === "POST") {
    const body = await readJsonBody<{ previewId?: unknown }>(request);
    if (!body || typeof body.previewId !== "string" || body.previewId.trim() === "") {
      return Errors.badRequest("Informe o identificador da prévia.");
    }
    const result = await applyPlan(env.DB, user.id, body.previewId, systemClock);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.expired) {
        return json({ error: { code: "preview_expired", message: "Esta prévia expirou. Gere uma nova." } }, { status: 409 });
      }
      if (result.stale) {
        return json(
          { error: { code: "preview_stale", message: "Sua disponibilidade ou pendências mudaram. Gere uma nova prévia." } },
          { status: 409 }
        );
      }
      return Errors.badRequest("Não foi possível aplicar o plano.");
    }
    if (!result.alreadyApplied) {
      await audit(env, "schedule_plan_applied", user.id, { appliedCount: result.appliedCount ?? 0 });
    }
    return json({ ok: true, appliedCount: result.appliedCount ?? 0 });
  }

  return null;
}

function transitionErrorResponse(result: { notFound?: boolean; conflict?: boolean; fieldErrors?: Record<string, string> }) {
  if (result.notFound) return Errors.notFound();
  if (result.conflict) {
    return json({ error: { code: "conflict", message: "Esta atividade foi alterada por outra requisição." } }, { status: 409 });
  }
  return json(
    { error: { code: "validation_error", message: "Não foi possível realizar esta ação.", fields: result.fieldErrors ?? {} } },
    { status: 400 }
  );
}

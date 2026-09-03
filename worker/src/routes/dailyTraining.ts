import type { Env } from "../env";
import { isLocalEditorialFixturesAllowed } from "../env";
import { Errors, json, readJsonBody } from "../lib/response";
import { readSessionToken } from "../lib/cookies";
import { checkSession } from "../services/authService";
import { recordAuditEvent, type AuditEventType } from "../repositories/auditRepository";
import { isQuestionBankAvailable } from "../repositories/questionRepository";
import {
  abandonList,
  applyList,
  completeList,
  getCurrent,
  getListDetail,
  preview,
  skipItem,
  startItem,
  syncItem,
} from "../services/dailyTrainingService";

/* Rotas do Treino Diário — Sprint 11 v1.0.

   Mesma ordem obrigatória de checagens do resto do namespace do aluno
   (Player/Caderno de Erros/Mapa ENEM desde as Sprints 8-10): 1) sessão
   válida (401); 2) disponibilidade do módulo — Sprint 16 v1.1 (A2):
   `isQuestionBankAvailable` (questionRepository.ts) substitui o antigo gate
   "só fixture local liga tudo": disponível em dev local com fixtures
   explicitamente habilitadas, OU em qualquer outro ambiente (produção
   real inclusive) quando existir ao menos uma questão REAL publicada;
   3) validação de parâmetros; 4) só então o serviço consulta/muta o banco.

   Um recurso (lista ou item) de outro aluno SEMPRE responde 404 (nunca
   403) — os repositórios já escopam por user_id no SQL, então "não
   encontrar" já é a resposta certa (mesmo padrão do Player/Caderno de
   Erros desde as Sprints 8-9).

   GETs (preview/current/:listId) são estritamente somente leitura (seção
   9 da ordem) — nunca chamam nenhuma função que grava no banco, e por
   isso NUNCA auditam (seção 14: "GETs sem auditoria"). */

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

function unavailableResponse(): Response {
  return json({ ok: true, available: false, message: "Ainda não há questões disponíveis para este treino." }, { status: 200 });
}

function conflictResponse(): Response {
  return Errors.conflict("Este item/lista foi alterado em outro lugar. Recarregue e tente novamente.");
}

function fieldErrorResponse(message: string, fields?: Record<string, string>): Response {
  return json({ error: { code: "validation_error", message, fields } }, { status: 400 });
}

function readMutationId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>).mutationId;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const LIST_ID_RE = /^\/api\/daily-training\/([^/]+)$/;
const START_RE = /^\/api\/daily-training\/([^/]+)\/items\/([^/]+)\/start$/;
const SYNC_RE = /^\/api\/daily-training\/([^/]+)\/items\/([^/]+)\/sync$/;
const SKIP_RE = /^\/api\/daily-training\/([^/]+)\/items\/([^/]+)\/skip$/;
const COMPLETE_RE = /^\/api\/daily-training\/([^/]+)\/complete$/;
const ABANDON_RE = /^\/api\/daily-training\/([^/]+)\/abandon$/;

export async function handleDailyTrainingRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith("/api/daily-training")) return null;

  const user = await requireUser(request, env);
  if (!user) return Errors.unauthorized();

  const available = await isQuestionBankAvailable(env, url, env.DB);
  if (!available) return unavailableResponse();
  // Sprint 16 v1.4 — corrige o achado da v1.3: com a flag habilitada,
  // fixtures editoriais voltam a ser servidas normalmente em dev local.
  const fixturesAllowed = isLocalEditorialFixturesAllowed(env, url);

  if (path === "/api/daily-training/preview") {
    if (method !== "GET") return Errors.methodNotAllowed();
    const result = await preview(env.DB, user.id, fixturesAllowed);
    return json({ ok: true, preview: result });
  }

  if (path === "/api/daily-training/apply") {
    if (method !== "POST") return Errors.methodNotAllowed();
    const body = await readJsonBody<{ mutationId?: unknown }>(request);
    const mutationId = readMutationId(body);
    if (!mutationId) return fieldErrorResponse("mutationId é obrigatório.", { mutationId: "mutationId é obrigatório." });
    const result = await applyList(env.DB, user.id, mutationId, fixturesAllowed);
    if (!result.ok) {
      if (result.empty) return json({ ok: true, empty: true });
      return fieldErrorResponse("Não foi possível aplicar o treino de hoje.", result.fieldErrors);
    }
    if (result.changed) await audit(env, "daily_training_applied", user.id, { listId: result.value!.listId });
    return json({ ok: true, listId: result.value!.listId });
  }

  if (path === "/api/daily-training/current") {
    if (method !== "GET") return Errors.methodNotAllowed();
    const list = await getCurrent(env.DB, user.id, fixturesAllowed);
    return json({ ok: true, list });
  }

  const completeMatch = path.match(COMPLETE_RE);
  if (completeMatch) {
    if (method !== "POST") return Errors.methodNotAllowed();
    const listId = completeMatch[1];
    const body = await readJsonBody<{ mutationId?: unknown }>(request);
    const mutationId = readMutationId(body);
    if (!mutationId) return fieldErrorResponse("mutationId é obrigatório.", { mutationId: "mutationId é obrigatório." });
    const result = await completeList(env.DB, user.id, listId, mutationId);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) return conflictResponse();
      return fieldErrorResponse("Não foi possível concluir o treino.", result.fieldErrors);
    }
    if (result.changed) await audit(env, "daily_training_completed", user.id, { listId });
    return json({ ok: true, summary: result.value!.summary });
  }

  const abandonMatch = path.match(ABANDON_RE);
  if (abandonMatch) {
    if (method !== "POST") return Errors.methodNotAllowed();
    const listId = abandonMatch[1];
    const body = await readJsonBody<{ mutationId?: unknown }>(request);
    const mutationId = readMutationId(body);
    if (!mutationId) return fieldErrorResponse("mutationId é obrigatório.", { mutationId: "mutationId é obrigatório." });
    const result = await abandonList(env.DB, user.id, listId, mutationId);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) return conflictResponse();
      return fieldErrorResponse("Não foi possível abandonar o treino.", result.fieldErrors);
    }
    if (result.changed) await audit(env, "daily_training_abandoned", user.id, { listId });
    return json({ ok: true });
  }

  const startMatch = path.match(START_RE);
  if (startMatch) {
    if (method !== "POST") return Errors.methodNotAllowed();
    const [, listId, itemId] = startMatch;
    const body = await readJsonBody<{ mutationId?: unknown }>(request);
    const mutationId = readMutationId(body);
    if (!mutationId) return fieldErrorResponse("mutationId é obrigatório.", { mutationId: "mutationId é obrigatório." });
    const result = await startItem(env.DB, user.id, listId, itemId, mutationId, fixturesAllowed);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) return conflictResponse();
      return fieldErrorResponse("Não foi possível iniciar este item.", result.fieldErrors);
    }
    if (result.changed) await audit(env, "daily_training_item_started", user.id, { listId, itemId, attemptId: result.value!.attemptId });
    return json({ ok: true, attemptId: result.value!.attemptId, questionId: result.value!.questionId });
  }

  const syncMatch = path.match(SYNC_RE);
  if (syncMatch) {
    if (method !== "POST") return Errors.methodNotAllowed();
    const [, listId, itemId] = syncMatch;
    const body = await readJsonBody<{ mutationId?: unknown }>(request);
    const mutationId = readMutationId(body);
    if (!mutationId) return fieldErrorResponse("mutationId é obrigatório.", { mutationId: "mutationId é obrigatório." });
    const result = await syncItem(env.DB, user.id, listId, itemId, mutationId);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) return conflictResponse();
      return fieldErrorResponse("Não foi possível sincronizar este item.", result.fieldErrors);
    }
    if (result.changed && result.value!.itemStatus === "completed") {
      await audit(env, "daily_training_item_completed", user.id, { listId, itemId });
    }
    return json({ ok: true, itemStatus: result.value!.itemStatus, isCorrect: result.value!.isCorrect });
  }

  const skipMatch = path.match(SKIP_RE);
  if (skipMatch) {
    if (method !== "POST") return Errors.methodNotAllowed();
    const [, listId, itemId] = skipMatch;
    const body = await readJsonBody<{ mutationId?: unknown; skipReason?: unknown }>(request);
    const mutationId = readMutationId(body);
    if (!mutationId) return fieldErrorResponse("mutationId é obrigatório.", { mutationId: "mutationId é obrigatório." });
    const skipReason = typeof body?.skipReason === "string" ? body.skipReason : "";
    const result = await skipItem(env.DB, user.id, listId, itemId, mutationId, skipReason);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) return conflictResponse();
      return fieldErrorResponse("Não foi possível pular este item.", result.fieldErrors);
    }
    if (result.changed) await audit(env, "daily_training_item_skipped", user.id, { listId, itemId, skipReason });
    return json({ ok: true });
  }

  const listMatch = path.match(LIST_ID_RE);
  if (listMatch) {
    if (method !== "GET") return Errors.methodNotAllowed();
    const listId = listMatch[1];
    const list = await getListDetail(env.DB, user.id, listId, fixturesAllowed);
    if (!list) return Errors.notFound();
    return json({ ok: true, list });
  }

  return null;
}

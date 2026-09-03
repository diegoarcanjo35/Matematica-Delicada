import type { Env } from "../env";
import { isLocalEditorialFixturesAllowed } from "../env";
import { Errors, json, readJsonBody } from "../lib/response";
import { readSessionToken } from "../lib/cookies";
import { checkSession } from "../services/authService";
import { recordAuditEvent, type AuditEventType } from "../repositories/auditRepository";
import { isQuestionBankAvailable } from "../repositories/questionRepository";
import {
  abandonBlock,
  applyBlock,
  completeBlock,
  getBlockDetail,
  getCurrent,
  getHistory,
  preview,
  skipItem,
  startItem,
  syncItem,
} from "../services/simulationsService";

/* Rotas dos Simulados em Blocos — Sprint 12 v1.0.

   Mesma ordem obrigatória de checagens do resto do namespace do aluno
   (Player/Treino Diário desde as Sprints 8/11): 1) sessão válida (401);
   2) gate local de fixtures (o simulado depende de questões e padrões
   publicados, o mesmo conteúdo técnico que já exige este gate); 3)
   validação de parâmetros; 4) só então o serviço consulta/muta o banco.

   Um recurso (bloco ou item) de outro aluno SEMPRE responde 404 (nunca
   403) — os repositórios já escopam por user_id no SQL.

   GETs (preview/current/:blockId/history) são estritamente somente leitura
   (seção 7/14 da ordem) — nunca chamam nenhuma função que grava no banco, e
   por isso NUNCA auditam (seção 18: "não auditar preview, GET, refresh ou
   retry idempotente"). */

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
  return json({ ok: true, available: false, message: "Ainda não há questões disponíveis para montar um simulado." }, { status: 200 });
}

function conflictResponse(): Response {
  return Errors.conflict("Este item/bloco foi alterado em outro lugar. Recarregue e tente novamente.");
}

function fieldErrorResponse(message: string, fields?: Record<string, string>): Response {
  return json({ error: { code: "validation_error", message, fields } }, { status: 400 });
}

function readMutationId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>).mutationId;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readPreviewParams(url: URL): { blockType: unknown; patternSlug: unknown; size: unknown } {
  const blockType = url.searchParams.get("blockType");
  const patternSlug = url.searchParams.get("patternSlug");
  const sizeRaw = url.searchParams.get("size");
  const size = sizeRaw !== null && /^\d+$/.test(sizeRaw) ? Number(sizeRaw) : sizeRaw;
  return { blockType, patternSlug, size };
}

const BLOCK_ID_RE = /^\/api\/simulations\/([^/]+)$/;
const START_RE = /^\/api\/simulations\/([^/]+)\/items\/([^/]+)\/start$/;
const SYNC_RE = /^\/api\/simulations\/([^/]+)\/items\/([^/]+)\/sync$/;
const SKIP_RE = /^\/api\/simulations\/([^/]+)\/items\/([^/]+)\/skip$/;
const COMPLETE_RE = /^\/api\/simulations\/([^/]+)\/complete$/;
const ABANDON_RE = /^\/api\/simulations\/([^/]+)\/abandon$/;
const RESERVED_IDS = new Set(["preview", "apply", "current", "history"]);

export async function handleSimulationsRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith("/api/simulations")) return null;

  const user = await requireUser(request, env);
  if (!user) return Errors.unauthorized();

  const available = await isQuestionBankAvailable(env, url, env.DB);
  if (!available) return unavailableResponse();
  // Sprint 16 v1.4 — corrige o achado da v1.3: com a flag habilitada,
  // fixtures editoriais voltam a ser servidas normalmente em dev local.
  const fixturesAllowed = isLocalEditorialFixturesAllowed(env, url);

  if (path === "/api/simulations/preview") {
    if (method !== "GET") return Errors.methodNotAllowed();
    const result = await preview(env.DB, user.id, readPreviewParams(url), fixturesAllowed);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      return fieldErrorResponse("Não foi possível montar a prévia do bloco.", result.fieldErrors);
    }
    return json({ ok: true, preview: result.preview });
  }

  if (path === "/api/simulations/apply") {
    if (method !== "POST") return Errors.methodNotAllowed();
    const body = await readJsonBody<{ mutationId?: unknown; blockType?: unknown; patternSlug?: unknown; size?: unknown }>(request);
    const mutationId = readMutationId(body);
    if (!mutationId) return fieldErrorResponse("mutationId é obrigatório.", { mutationId: "mutationId é obrigatório." });
    const result = await applyBlock(
      env.DB,
      user.id,
      { mutationId, blockType: body?.blockType, patternSlug: body?.patternSlug, size: body?.size },
      fixturesAllowed
    );
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.empty) return json({ ok: true, empty: true });
      if (result.activeElsewhere) return fieldErrorResponse("Você já tem um bloco de simulado ativo.", result.fieldErrors);
      return fieldErrorResponse("Não foi possível aplicar o bloco de simulado.", result.fieldErrors);
    }
    if (result.changed) await audit(env, "simulation_block_applied", user.id, { blockId: result.value!.blockId });
    return json({ ok: true, blockId: result.value!.blockId });
  }

  if (path === "/api/simulations/current") {
    if (method !== "GET") return Errors.methodNotAllowed();
    const block = await getCurrent(env.DB, user.id, fixturesAllowed);
    return json({ ok: true, block });
  }

  if (path === "/api/simulations/history") {
    if (method !== "GET") return Errors.methodNotAllowed();
    const beforeCreatedAt = url.searchParams.get("beforeCreatedAt");
    const beforeId = url.searchParams.get("beforeId");
    const before = beforeCreatedAt && beforeId ? { createdAt: beforeCreatedAt, id: beforeId } : null;
    const result = await getHistory(env.DB, user.id, before);
    return json({ ok: true, entries: result.entries, hasMore: result.hasMore });
  }

  const completeMatch = path.match(COMPLETE_RE);
  if (completeMatch) {
    if (method !== "POST") return Errors.methodNotAllowed();
    const blockId = completeMatch[1];
    const body = await readJsonBody<{ mutationId?: unknown }>(request);
    const mutationId = readMutationId(body);
    if (!mutationId) return fieldErrorResponse("mutationId é obrigatório.", { mutationId: "mutationId é obrigatório." });
    const result = await completeBlock(env.DB, user.id, blockId, mutationId);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) return conflictResponse();
      return fieldErrorResponse("Não foi possível concluir o bloco.", result.fieldErrors);
    }
    if (result.changed) await audit(env, "simulation_block_completed", user.id, { blockId });
    return json({ ok: true, summary: result.value!.summary });
  }

  const abandonMatch = path.match(ABANDON_RE);
  if (abandonMatch) {
    if (method !== "POST") return Errors.methodNotAllowed();
    const blockId = abandonMatch[1];
    const body = await readJsonBody<{ mutationId?: unknown }>(request);
    const mutationId = readMutationId(body);
    if (!mutationId) return fieldErrorResponse("mutationId é obrigatório.", { mutationId: "mutationId é obrigatório." });
    const result = await abandonBlock(env.DB, user.id, blockId, mutationId);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) return conflictResponse();
      return fieldErrorResponse("Não foi possível abandonar o bloco.", result.fieldErrors);
    }
    if (result.changed) await audit(env, "simulation_block_abandoned", user.id, { blockId });
    return json({ ok: true });
  }

  const startMatch = path.match(START_RE);
  if (startMatch) {
    if (method !== "POST") return Errors.methodNotAllowed();
    const [, blockId, itemId] = startMatch;
    const body = await readJsonBody<{ mutationId?: unknown }>(request);
    const mutationId = readMutationId(body);
    if (!mutationId) return fieldErrorResponse("mutationId é obrigatório.", { mutationId: "mutationId é obrigatório." });
    const result = await startItem(env.DB, user.id, blockId, itemId, mutationId, fixturesAllowed);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) return conflictResponse();
      return fieldErrorResponse("Não foi possível iniciar este item.", result.fieldErrors);
    }
    if (result.changed) await audit(env, "simulation_item_started", user.id, { blockId, itemId, attemptId: result.value!.attemptId });
    return json({ ok: true, attemptId: result.value!.attemptId, questionId: result.value!.questionId });
  }

  const syncMatch = path.match(SYNC_RE);
  if (syncMatch) {
    if (method !== "POST") return Errors.methodNotAllowed();
    const [, blockId, itemId] = syncMatch;
    const body = await readJsonBody<{ mutationId?: unknown }>(request);
    const mutationId = readMutationId(body);
    if (!mutationId) return fieldErrorResponse("mutationId é obrigatório.", { mutationId: "mutationId é obrigatório." });
    const result = await syncItem(env.DB, user.id, blockId, itemId, mutationId);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) return conflictResponse();
      return fieldErrorResponse("Não foi possível sincronizar este item.", result.fieldErrors);
    }
    if (result.changed && result.value!.itemStatus === "completed") {
      await audit(env, "simulation_item_completed", user.id, { blockId, itemId });
    }
    return json({ ok: true, itemStatus: result.value!.itemStatus, isCorrect: result.value!.isCorrect });
  }

  const skipMatch = path.match(SKIP_RE);
  if (skipMatch) {
    if (method !== "POST") return Errors.methodNotAllowed();
    const [, blockId, itemId] = skipMatch;
    const body = await readJsonBody<{ mutationId?: unknown }>(request);
    const mutationId = readMutationId(body);
    if (!mutationId) return fieldErrorResponse("mutationId é obrigatório.", { mutationId: "mutationId é obrigatório." });
    const result = await skipItem(env.DB, user.id, blockId, itemId, mutationId);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) return conflictResponse();
      return fieldErrorResponse("Não foi possível pular este item.", result.fieldErrors);
    }
    if (result.changed) await audit(env, "simulation_item_skipped", user.id, { blockId, itemId });
    return json({ ok: true });
  }

  const blockMatch = path.match(BLOCK_ID_RE);
  if (blockMatch && !RESERVED_IDS.has(blockMatch[1])) {
    if (method !== "GET") return Errors.methodNotAllowed();
    const blockId = blockMatch[1];
    const block = await getBlockDetail(env.DB, user.id, blockId, fixturesAllowed);
    if (!block) return Errors.notFound();
    return json({ ok: true, block });
  }

  return null;
}

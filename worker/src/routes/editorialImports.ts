import type { Env } from "../env";
import { Errors, json } from "../lib/response";
import { readSessionToken } from "../lib/cookies";
import { checkSession } from "../services/authService";
import { resolveEditorialRole, roleSatisfies } from "../lib/rbac";
import { isValidQuestionId } from "../lib/questionsValidation";
import {
  applyImport,
  getImportBatchStatus,
  IMPORT_CSV_HEADERS,
  IMPORT_MAX_FILE_BYTES,
  previewImport,
  undoImport,
} from "../services/questionImportService";

/* Rotas de importação CSV — Sprint 7 v1.0, seção 8.2 da ordem.

   O corpo de preview é o CSV BRUTO (Content-Type: text/csv), NUNCA JSON —
   por isso não usa lib/response.ts:readJsonBody (limite de 16KB, pensado
   para payloads de API pequenos). Aqui o limite é o próprio
   IMPORT_MAX_FILE_BYTES, checado ANTES de decodificar qualquer conteúdo. */

async function requireEditorialActor(request: Request, env: Env): Promise<{ userId: string; role: "editor" | "admin" } | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const session = await checkSession(env.DB, token);
  if (!session.ok || !session.user) return null;
  const role = await resolveEditorialRole(env.DB, session.user.id);
  if (role === null) return null;
  return { userId: session.user.id, role };
}

/** Template CSV versionado — mesmas colunas de IMPORT_CSV_HEADERS, sempre
 *  em sincronia (fonte única). Uma linha de exemplo FIXTURE TÉCNICA, nunca
 *  conteúdo oficial. Espelhado em docs/templates/questoes-importacao-v1.csv
 *  para download fora da API (ver docs/templates/README.md). */
function buildTemplateCsv(): string {
  const exampleRow = [
    "FIX-IMPORT-001",
    "FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Exemplo de enunciado para o template de importação.",
    "Resolução comentada de exemplo, apenas técnica.",
    "Razão e proporção",
    "Leitura de gráficos",
    "Comparar grandezas",
    "Interpretar dados",
    "media",
    "autoral",
    "",
    "",
    "90",
    "misto",
    "nao",
    "Alternativa A de exemplo",
    "Alternativa B de exemplo",
    "Alternativa C de exemplo (correta)",
    "Alternativa D de exemplo",
    "Alternativa E de exemplo",
    "C",
    "Pista de exemplo",
    "Estratégia de exemplo",
    "Pegadinha de exemplo",
    "Conteúdo de apoio de exemplo",
    "Resolução de exemplo do DNA",
    "",
    "Aprendizado do erro de exemplo",
    "PAD-01",
    "",
    "exemplo;template",
    "Fixture técnica interna",
    "Uso interno de desenvolvimento — não publicável",
    "",
    "",
    "",
  ];
  const escape = (value: string): string => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return [IMPORT_CSV_HEADERS.join(","), exampleRow.map(escape).join(",")].join("\r\n") + "\r\n";
}

const BATCH_ID_RE = /^\/api\/editorial\/question-imports\/([^/]+)$/;
const BATCH_UNDO_RE = /^\/api\/editorial\/question-imports\/([^/]+)\/undo$/;

export async function handleEditorialImportsRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path !== "/api/editorial/question-imports" && !path.startsWith("/api/editorial/question-imports/")) return null;

  if (path === "/api/editorial/question-imports/template") {
    if (request.method !== "GET") return Errors.methodNotAllowed();
    const actor = await requireEditorialActor(request, env);
    if (!actor) return Errors.forbidden("Sem permissão editorial.");
    return new Response(buildTemplateCsv(), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="questoes-importacao-v1.csv"',
      },
    });
  }

  const actor = await requireEditorialActor(request, env);
  if (!actor) {
    const token = readSessionToken(request);
    if (!token) return Errors.unauthorized();
    return Errors.forbidden("Sem permissão editorial.");
  }

  if (path === "/api/editorial/question-imports/preview") {
    if (request.method !== "POST") return Errors.methodNotAllowed();

    const contentLength = request.headers.get("content-length");
    if (contentLength && Number(contentLength) > IMPORT_MAX_FILE_BYTES) {
      return Errors.payloadTooLarge(`Arquivo excede o limite de ${IMPORT_MAX_FILE_BYTES} bytes.`);
    }
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > IMPORT_MAX_FILE_BYTES) {
      return Errors.payloadTooLarge(`Arquivo excede o limite de ${IMPORT_MAX_FILE_BYTES} bytes.`);
    }

    const result = await previewImport(env.DB, actor.userId, new Uint8Array(buffer));
    if (!result.ok) {
      return json({ error: { code: "import_invalid", message: result.message ?? "CSV inválido.", reason: result.reason } }, { status: 400 });
    }
    return json({
      ok: true,
      batchId: result.batchId,
      rowCount: result.rowCount,
      validRowCount: result.validRowCount,
      errorCount: result.errorCount,
      errors: result.errors,
      // CSV pronto para download com o mesmo relatório, mas com
      // neutralização de fórmula aplicada (Correção B, Sprint 7 v1.1) —
      // presentation-only, nunca altera o conteúdo armazenado.
      errorsReportCsv: result.errorsReportCsv ?? null,
      expiresAt: result.expiresAt,
      canApply: result.errorCount === 0,
    });
  }

  if (path === "/api/editorial/question-imports/apply") {
    if (request.method !== "POST") return Errors.methodNotAllowed();
    const body = await request.json().catch(() => null) as { batchId?: string } | null;
    if (!body || !isValidQuestionId(body.batchId)) return Errors.badRequest("Informe batchId.");

    const result = await applyImport(env.DB, actor.userId, body.batchId);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.expired) return json({ error: { code: "preview_expired", message: "A prévia expirou. Gere uma nova." } }, { status: 409 });
      if (result.conflict) return json({ error: { code: "import_conflict", message: "Um ou mais itens já existem no banco. Gere uma nova prévia." } }, { status: 409 });
      return json({ error: { code: "import_invalid", message: "Prévia inválida ou com erros pendentes." } }, { status: 400 });
    }
    return json({ ok: true, appliedCount: result.appliedCount ?? 0, alreadyApplied: result.alreadyApplied ?? false, questionIds: result.questionIds ?? [] });
  }

  const undoMatch = path.match(BATCH_UNDO_RE);
  if (undoMatch) {
    if (request.method !== "POST") return Errors.methodNotAllowed();
    if (!roleSatisfies(actor.role, "admin")) return Errors.forbidden("Desfazer importação exige papel admin.");
    const batchId = undoMatch[1];
    if (!isValidQuestionId(batchId)) return Errors.notFound();

    const result = await undoImport(env.DB, actor.userId, batchId);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.blocked) {
        return json({ error: { code: "undo_blocked", message: "Lote não pode ser desfeito (não aplicado ou alguma questão já saiu de rascunho)." } }, { status: 409 });
      }
      return Errors.internal();
    }
    return json({ ok: true, undoneCount: result.undoneCount ?? 0, alreadyUndone: result.alreadyUndone ?? false });
  }

  const idMatch = path.match(BATCH_ID_RE);
  if (idMatch) {
    if (request.method !== "GET") return Errors.methodNotAllowed();
    const batchId = idMatch[1];
    if (!isValidQuestionId(batchId)) return Errors.notFound();
    const status = await getImportBatchStatus(env.DB, batchId, actor.userId);
    if (!status) return Errors.notFound();
    return json({ ok: true, batch: status });
  }

  return Errors.notFound();
}

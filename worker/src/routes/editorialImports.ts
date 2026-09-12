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
import { buildTemplateCsvV2 } from "../lib/questionImportV2";
import { applyPackage, previewPackage, PACKAGE_MAX_FILE_BYTES } from "../services/questionPackageImportService";
import {
  applyPdf,
  previewPdf,
  PDF_ANSWER_KEY_MAX_BYTES,
  PDF_EXAM_MAX_BYTES,
  type PdfApplySelectionEntry,
} from "../services/questionPdfImportService";
import type { VisualPlacementCandidate } from "../lib/pdfEnemVisualModel";

/* Sprint 19, seção 8/17 da ordem — teto do CORPO multipart do apply de
   pacote ZIP (arquivo ZIP + boundary/campos ao redor). Mesma disciplina de
   Content-Length obrigatório e fail-closed validada na Sprint 18.1/18.2
   (worker/src/routes/editorialQuestions.ts) — nunca um cheque "só se o
   cabeçalho existir". */
const PACKAGE_MAX_MULTIPART_BYTES = PACKAGE_MAX_FILE_BYTES + 1024 * 1024; // 1 MB de margem de overhead multipart.

/* Sprint 22, seção 24 da ordem — teto do CORPO multipart do preview/apply
   de PDF (dois arquivos: prova + gabarito, + campos de identidade ao
   redor). Mesma disciplina de Content-Length obrigatório e fail-closed. */
const PDF_PREVIEW_MULTIPART_MAX_BYTES = PDF_EXAM_MAX_BYTES + PDF_ANSWER_KEY_MAX_BYTES + 2 * 1024 * 1024; // 2 MB de margem.

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

  // Sprint 19, seção 3 da ordem — template V2, agora o padrão oferecido
  // pela UI (o V1 acima continua existindo só por compatibilidade — nunca
  // mais o recomendado).
  if (path === "/api/editorial/question-imports/template-v2") {
    if (request.method !== "GET") return Errors.methodNotAllowed();
    const actor = await requireEditorialActor(request, env);
    if (!actor) return Errors.forbidden("Sem permissão editorial.");
    return new Response(buildTemplateCsvV2(), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="questoes-importacao-v2.csv"',
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
      if (result.tooManyStatements) {
        return json({ error: { code: "import_too_many_statements", message: result.message ?? "Arquivo grande demais para aplicar de uma vez." } }, { status: 413 });
      }
      return json({ error: { code: "import_invalid", message: "Prévia inválida ou com erros pendentes." } }, { status: 400 });
    }
    return json({ ok: true, appliedCount: result.appliedCount ?? 0, alreadyApplied: result.alreadyApplied ?? false, questionIds: result.questionIds ?? [] });
  }

  // Sprint 19, seções 5-13/17 da ordem — Pacote ZIP (CSV V2 + imagens +
  // manifest), endpoints SEPARADOS dos de CSV puro acima (nunca reaproveita
  // /preview ou /apply genéricos) — reduz risco e mantém compatibilidade
  // total com o fluxo CSV já em produção.
  if (path === "/api/editorial/question-imports/package/preview") {
    if (request.method !== "POST") return Errors.methodNotAllowed();

    // Mesma disciplina fail-closed de Content-Length da Sprint 18.1 —
    // corpo é o ZIP bruto (nunca multipart aqui: preview não precisa de
    // nenhum campo além do arquivo em si).
    const contentLengthRaw = request.headers.get("content-length");
    if (contentLengthRaw === null || !/^\d+$/.test(contentLengthRaw) || Number(contentLengthRaw) <= 0) {
      return Errors.badRequest("Cabeçalho Content-Length obrigatório e válido para upload de pacote.");
    }
    if (Number(contentLengthRaw) > PACKAGE_MAX_FILE_BYTES) {
      return Errors.payloadTooLarge(`Pacote excede o limite de ${PACKAGE_MAX_FILE_BYTES} bytes.`);
    }

    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > PACKAGE_MAX_FILE_BYTES) {
      return Errors.payloadTooLarge(`Pacote excede o limite de ${PACKAGE_MAX_FILE_BYTES} bytes.`);
    }

    const result = await previewPackage(env.DB, actor.userId, new Uint8Array(buffer));
    if (!result.ok) {
      return json({ error: { code: "package_invalid", message: result.message ?? "Pacote inválido.", errors: result.errors ?? [] } }, { status: 400 });
    }
    return json({
      ok: true,
      batchId: result.batchId,
      rowCount: result.rowCount,
      validRowCount: result.validRowCount,
      imageCount: result.imageCount,
      errorCount: result.errorCount,
      questions: result.questions,
      expiresAt: result.expiresAt,
      canApply: (result.errorCount ?? 0) === 0,
    });
  }

  if (path === "/api/editorial/question-imports/package/apply") {
    if (request.method !== "POST") return Errors.methodNotAllowed();
    if (!env.QUESTION_MEDIA) return Errors.internal("Armazenamento de mídia não configurado neste ambiente.");

    const contentLengthRaw = request.headers.get("content-length");
    if (contentLengthRaw === null || !/^\d+$/.test(contentLengthRaw) || Number(contentLengthRaw) <= 0) {
      return Errors.badRequest("Cabeçalho Content-Length obrigatório e válido para upload de pacote.");
    }
    if (Number(contentLengthRaw) > PACKAGE_MAX_MULTIPART_BYTES) {
      return Errors.payloadTooLarge(`Corpo da requisição excede o limite permitido para aplicar o pacote.`);
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return Errors.badRequest("Corpo multipart/form-data inválido.");
    }
    const batchId = form.get("batchId");
    if (!isValidQuestionId(batchId)) return Errors.badRequest("Informe batchId.");
    const file = form.get("arquivo");
    if (!(file instanceof File)) return Errors.badRequest("Campo 'arquivo' é obrigatório (o mesmo pacote ZIP selecionado no preview).");
    const zipBytes = new Uint8Array(await file.arrayBuffer());
    if (zipBytes.byteLength > PACKAGE_MAX_FILE_BYTES) {
      return Errors.payloadTooLarge(`Pacote excede o limite de ${PACKAGE_MAX_FILE_BYTES} bytes.`);
    }

    const result = await applyPackage(env.DB, env.QUESTION_MEDIA, actor.userId, batchId, zipBytes);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.expired) return json({ error: { code: "preview_expired", message: "A prévia expirou. Gere uma nova." } }, { status: 409 });
      if (result.fingerprintMismatch) {
        return json({ error: { code: "package_fingerprint_mismatch", message: "O pacote reenviado é diferente do que gerou esta prévia. Gere uma nova prévia." } }, { status: 409 });
      }
      if (result.conflict) {
        return json({ error: { code: "package_conflict", message: result.conflictReason ?? "Um ou mais itens já existem. Gere uma nova prévia." } }, { status: 409 });
      }
      if (result.tooManyStatements) {
        return json({ error: { code: "package_too_many_statements", message: result.message ?? "Pacote grande demais para aplicar de uma vez." } }, { status: 413 });
      }
      return json({ error: { code: "package_invalid", message: "Prévia inválida ou com erros pendentes." } }, { status: 400 });
    }
    return json({
      ok: true,
      appliedCount: result.appliedCount ?? 0,
      imageCount: result.imageCount ?? 0,
      alreadyApplied: result.alreadyApplied ?? false,
      questionIds: result.questionIds ?? [],
    });
  }

  // Sprint 22 — PDF oficial do ENEM (prova + gabarito), namespace SEPARADO
  // dos de CSV/ZIP acima (mesmo cuidado de isolamento da Sprint 19: nunca
  // reaproveita /preview ou /apply genéricos). Corpo sempre multipart/
  // form-data — preview já recebe os dois PDFs (nunca só um), porque a
  // identidade do exame precisa ser confirmada e o casamento questão↔
  // gabarito calculado antes de qualquer prévia existir (seção 18/19 da
  // ordem).
  if (path === "/api/editorial/question-imports/pdf/preview") {
    if (request.method !== "POST") return Errors.methodNotAllowed();

    const contentLengthRaw = request.headers.get("content-length");
    if (contentLengthRaw === null || !/^\d+$/.test(contentLengthRaw) || Number(contentLengthRaw) <= 0) {
      return Errors.badRequest("Cabeçalho Content-Length obrigatório e válido para upload de PDF.");
    }
    if (Number(contentLengthRaw) > PDF_PREVIEW_MULTIPART_MAX_BYTES) {
      return Errors.payloadTooLarge("Corpo da requisição excede o limite permitido para gerar a prévia.");
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return Errors.badRequest("Corpo multipart/form-data inválido.");
    }

    const examPdf = form.get("examPdf");
    const answerKeyPdf = form.get("answerKeyPdf");
    if (!(examPdf instanceof File)) return Errors.badRequest("Campo 'examPdf' é obrigatório (PDF da prova).");
    if (!(answerKeyPdf instanceof File)) return Errors.badRequest("Campo 'answerKeyPdf' é obrigatório (PDF do gabarito oficial).");

    const examBytes = new Uint8Array(await examPdf.arrayBuffer());
    if (examBytes.byteLength > PDF_EXAM_MAX_BYTES) return Errors.payloadTooLarge(`PDF da prova excede o limite de ${PDF_EXAM_MAX_BYTES} bytes.`);
    const answerKeyBytes = new Uint8Array(await answerKeyPdf.arrayBuffer());
    if (answerKeyBytes.byteLength > PDF_ANSWER_KEY_MAX_BYTES) return Errors.payloadTooLarge(`PDF do gabarito excede o limite de ${PDF_ANSWER_KEY_MAX_BYTES} bytes.`);

    const confirmation = form.get("confirmation") === "true";
    const identityInput = {
      year: form.get("year"),
      application: form.get("application"),
      booklet: form.get("booklet"),
      languageVariant: form.get("languageVariant"),
      sourceUrl: form.get("sourceUrl"),
    };

    const result = await previewPdf(env.DB, actor.userId, examBytes, answerKeyBytes, identityInput, confirmation);
    if (!result.ok) {
      return json({ error: { code: `pdf_${result.reason ?? "invalid"}`, message: result.message ?? "PDF inválido.", errors: result.errors ?? [] } }, { status: 400 });
    }
    return json({
      ok: true,
      batchId: result.batchId,
      examIdentity: result.examIdentity,
      documentIdentityCheck: result.documentIdentityCheck,
      pageCount: result.pageCount,
      detectedQuestionCount: result.detectedQuestionCount,
      matchedAnswerCount: result.matchedAnswerCount,
      questions: result.questions,
      globalWarnings: result.globalWarnings ?? [],
      canApply: result.canApply ?? false,
      expiresAt: result.expiresAt,
    });
  }

  if (path === "/api/editorial/question-imports/pdf/apply") {
    if (request.method !== "POST") return Errors.methodNotAllowed();

    const contentLengthRaw = request.headers.get("content-length");
    if (contentLengthRaw === null || !/^\d+$/.test(contentLengthRaw) || Number(contentLengthRaw) <= 0) {
      return Errors.badRequest("Cabeçalho Content-Length obrigatório e válido para aplicar o PDF.");
    }
    if (Number(contentLengthRaw) > PDF_PREVIEW_MULTIPART_MAX_BYTES) {
      return Errors.payloadTooLarge("Corpo da requisição excede o limite permitido para aplicar.");
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return Errors.badRequest("Corpo multipart/form-data inválido.");
    }

    const batchId = form.get("batchId");
    if (!isValidQuestionId(batchId)) return Errors.badRequest("Informe batchId.");
    const examPdf = form.get("examPdf");
    const answerKeyPdf = form.get("answerKeyPdf");
    if (!(examPdf instanceof File)) return Errors.badRequest("Campo 'examPdf' é obrigatório (o mesmo PDF da prova selecionado no preview).");
    if (!(answerKeyPdf instanceof File)) return Errors.badRequest("Campo 'answerKeyPdf' é obrigatório (o mesmo PDF do gabarito selecionado no preview).");

    const examBytes = new Uint8Array(await examPdf.arrayBuffer());
    if (examBytes.byteLength > PDF_EXAM_MAX_BYTES) return Errors.payloadTooLarge(`PDF da prova excede o limite de ${PDF_EXAM_MAX_BYTES} bytes.`);
    const answerKeyBytes = new Uint8Array(await answerKeyPdf.arrayBuffer());
    if (answerKeyBytes.byteLength > PDF_ANSWER_KEY_MAX_BYTES) return Errors.payloadTooLarge(`PDF do gabarito excede o limite de ${PDF_ANSWER_KEY_MAX_BYTES} bytes.`);

    const identityInput = {
      year: form.get("year"),
      application: form.get("application"),
      booklet: form.get("booklet"),
      languageVariant: form.get("languageVariant"),
      sourceUrl: form.get("sourceUrl"),
    };

    const selectionRaw = form.get("selection");
    if (typeof selectionRaw !== "string") return Errors.badRequest("Informe 'selection' (JSON com as questões escolhidas e seus padrões).");
    let selection: PdfApplySelectionEntry[];
    try {
      const parsed = JSON.parse(selectionRaw) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not an array");
      selection = parsed.map((entry) => {
        const e = entry as {
          originalNumber?: unknown;
          patternPrincipalId?: unknown;
          reviewedStatement?: unknown;
          reviewedAlternatives?: unknown;
          visualConfirmations?: unknown;
        };
        if (typeof e.originalNumber !== "number" || typeof e.patternPrincipalId !== "string" || !e.patternPrincipalId) {
          throw new Error("invalid entry");
        }
        const result: PdfApplySelectionEntry = { originalNumber: e.originalNumber, patternPrincipalId: e.patternPrincipalId };
        // Seção 5/7 da ordem — correção editorial OPCIONAL de enunciado/
        // alternativas; NUNCA um campo de gabarito/resposta correta aqui
        // (a interface não permite — ver PdfApplySelectionEntry). Validação
        // estrutural completa (5 letras A-E, textos não vazios) acontece no
        // serviço, nunca só aqui.
        if (e.reviewedStatement !== undefined) {
          if (typeof e.reviewedStatement !== "string") throw new Error("invalid reviewedStatement");
          result.reviewedStatement = e.reviewedStatement;
        }
        if (e.reviewedAlternatives !== undefined) {
          if (!Array.isArray(e.reviewedAlternatives)) throw new Error("invalid reviewedAlternatives");
          result.reviewedAlternatives = e.reviewedAlternatives.map((alt) => {
            const a = alt as { letter?: unknown; text?: unknown };
            if (typeof a.letter !== "string" || !["A", "B", "C", "D", "E"].includes(a.letter) || typeof a.text !== "string") {
              throw new Error("invalid reviewed alternative");
            }
            return { letter: a.letter as "A" | "B" | "C" | "D" | "E", text: a.text };
          });
        }
        // Sprint 23, seção 8/10 da ordem — confirmação editorial OPCIONAL
        // (só existe quando a questão tem imagem(ns) raster pendente) de
        // posicionamento + texto alternativo. Validação estrutural
        // completa (contagem, hash conhecido, placement != unknown, alt
        // text não vazio) acontece no serviço — aqui só a forma do JSON.
        if (e.visualConfirmations !== undefined) {
          if (!Array.isArray(e.visualConfirmations)) throw new Error("invalid visualConfirmations");
          result.visualConfirmations = e.visualConfirmations.map((vc) => {
            const v = vc as { elementHash?: unknown; placement?: unknown; altText?: unknown };
            if (typeof v.elementHash !== "string" || !v.elementHash || typeof v.placement !== "string" || typeof v.altText !== "string") {
              throw new Error("invalid visual confirmation");
            }
            return { elementHash: v.elementHash, placement: v.placement as VisualPlacementCandidate, altText: v.altText };
          });
        }
        return result;
      });
    } catch {
      return Errors.badRequest("Campo 'selection' inválido.");
    }

    if (!env.QUESTION_MEDIA) return Errors.internal("Armazenamento de mídia não configurado neste ambiente.");
    const result = await applyPdf(env.DB, env.QUESTION_MEDIA, actor.userId, batchId, examBytes, answerKeyBytes, identityInput, selection);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.expired) return json({ error: { code: "preview_expired", message: "A prévia expirou. Gere uma nova." } }, { status: 409 });
      if (result.fingerprintMismatch) {
        return json({ error: { code: "pdf_fingerprint_mismatch", message: "Os PDFs reenviados são diferentes dos que geraram esta prévia. Gere uma nova prévia." } }, { status: 409 });
      }
      if (result.identityMismatch) {
        return json({ error: { code: "pdf_identity_mismatch", message: "A identidade do exame informada não corresponde à desta prévia." } }, { status: 409 });
      }
      if (result.conflict) {
        return json({ error: { code: "pdf_conflict", message: result.conflictReason ?? "Um ou mais itens não podem ser aplicados. Revise a seleção." } }, { status: 409 });
      }
      if (result.tooManyStatements) {
        return json({ error: { code: "pdf_too_many_statements", message: result.message ?? "Seleção grande demais para aplicar de uma vez." } }, { status: 413 });
      }
      if (result.visualBytesExceeded) {
        return json({ error: { code: "pdf_visual_bytes_exceeded", message: result.message ?? "Total de imagens confirmadas excede o limite permitido." } }, { status: 413 });
      }
      return json({ error: { code: "pdf_invalid", message: result.message ?? "Prévia inválida ou seleção com erros pendentes." } }, { status: 400 });
    }
    return json({
      ok: true,
      appliedCount: result.appliedCount ?? 0,
      alreadyApplied: result.alreadyApplied ?? false,
      questionIds: result.questionIds ?? [],
    });
  }

  const undoMatch = path.match(BATCH_UNDO_RE);
  if (undoMatch) {
    if (request.method !== "POST") return Errors.methodNotAllowed();
    if (!roleSatisfies(actor.role, "admin")) return Errors.forbidden("Desfazer importação exige papel admin.");
    const batchId = undoMatch[1];
    if (!isValidQuestionId(batchId)) return Errors.notFound();

    // Sprint 19, seção 15 da ordem — undo GENÉRICO continua servindo tanto
    // lotes CSV quanto de Pacote ZIP; `bucket` é opcional (só usado se o
    // lote realmente tiver imagens R2, ver undoImport).
    const result = await undoImport(env.DB, actor.userId, batchId, env.QUESTION_MEDIA);
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

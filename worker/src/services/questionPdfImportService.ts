/* Serviço de importação de PDF oficial do ENEM — Sprint 22.

   Reaproveita deliberadamente a MESMA arquitetura do Pacote ZIP (Sprint
   19, questionPackageImportService.ts): `question_import_batches.payload`
   guarda um objeto `{sourceKind:'pdf_enem', ...}` (nenhuma migration —
   seção 43 da ordem); apply RE-RECEBE os bytes originais (os dois PDFs,
   agora via multipart) e RE-EXTRAI/RE-SEGMENTA do zero, nunca confiando
   no preview como fonte de verdade — só como o que SERIA aplicado, com o
   fingerprint combinado dos dois arquivos como prova de que é literalmente
   o mesmo conteúdo (seção 22 da ordem).

   Preview NUNCA escreve em `questions`/`question_images`/R2 (seção 19).
   Apply só cria questões em `draft` (seção 20) — nunca aceita status vindo
   do cliente. Esta sprint v1 NÃO extrai imagem automaticamente do PDF (ver
   relatório final: rasterização de XObject de imagem exigiria canvas,
   indisponível no runtime do Worker sem uma dependência de imaging não
   avaliada nesta sprint) — toda questão com conteúdo visual detectado é
   marcada `visualReviewRequired=true` e cai em `needs_review`; a Andreia
   anexa a imagem manualmente pelo editor de questão já existente
   (explicitamente permitido pela seção 10 da ordem). Por isso `apply`
   AQUI nunca sobe nada ao R2 e nunca grava `question_images`. */

import { extractPdfPages, PDF_MAX_BYTES, type PdfPageText } from "../lib/pdfEnemExtractor";
import { segmentExamQuestions, MAX_QUESTION_NUMBER } from "../lib/pdfEnemSegmenter";
import { parseAnswerKeyFromPageLines, type AnswerLetter } from "../lib/pdfEnemAnswerKey";
import {
  buildPdfEnemQuestionCode,
  buildPreviewQuestions,
  type PdfEnemPreviewQuestion,
} from "../lib/pdfEnemMatch";
import {
  describeExamIdentity,
  examIdentitiesCompatible,
  validateExamIdentityInput,
  type ExamIdentity,
  type ExamIdentityInput,
} from "../lib/pdfEnemExamIdentity";
import { sha256HexOfBytes } from "../lib/crypto";
import { queryExistingCodes, queryExistingFingerprints } from "../lib/importValidationContext";
import { isPayloadWithinBatchLimit, PAYLOAD_TOO_LARGE_MESSAGE, IMPORT_BATCH_MAX_D1_STATEMENTS, plannedD1StatementCountForRows } from "../lib/importBatchLimits";
import { recordAuditEvent } from "../repositories/auditRepository";
import { insertImportBatch, findImportBatch, buildInsertImportItemStatement, buildMarkBatchAppliedStatement, listImportItems } from "../repositories/questionImportRepository";
import {
  buildConditionalHistoryStatement,
  buildInsertAlternativeStatement,
  buildInsertPatternLinkStatement,
  buildInsertQuestionStatement,
  buildUpsertDnaStatement,
} from "../repositories/questionRepository";
import type { AlternativeInput } from "../lib/questionsValidation";

function newId(): string {
  return crypto.randomUUID();
}

/* Seção 24 da ordem — limites explícitos, fail-closed. */
export const PDF_EXAM_MAX_BYTES = PDF_MAX_BYTES; // 40MB
export const PDF_ANSWER_KEY_MAX_BYTES = 5 * 1024 * 1024; // 5MB — gabarito é um documento pequeno.
export const PDF_MAX_QUESTIONS_PER_BATCH = MAX_QUESTION_NUMBER; // mesmo teto estrutural do segmentador (200).

export interface PdfBatchPayload {
  sourceKind: "pdf_enem";
  identity: ExamIdentity;
  examFingerprint: string;
  answerKeyFingerprint: string;
  questions: PdfEnemPreviewQuestion[];
}

export interface PdfPreviewResult {
  ok: boolean;
  batchId?: string;
  examIdentity?: ExamIdentity;
  pageCount?: number;
  detectedQuestionCount?: number;
  matchedAnswerCount?: number;
  questions?: PdfEnemPreviewQuestion[];
  globalWarnings?: string[];
  canApply?: boolean;
  expiresAt?: string;
  reason?: "needs_ocr_exam" | "needs_ocr_answer_key" | "invalid_exam" | "invalid_answer_key" | "too_large" | "too_many_questions" | "invalid_identity" | "payload_too_large" | "too_many_statements" | "confirmation_required";
  message?: string;
  errors?: string[];
}

async function fingerprintPagesText(pages: PdfPageText[]): Promise<string[][]> {
  return pages.map((p) => p.lines.map((l) => l.text));
}

export async function previewPdf(
  db: D1Database,
  actorUserId: string,
  examBytes: Uint8Array,
  answerKeyBytes: Uint8Array,
  identityInput: ExamIdentityInput,
  confirmation: boolean
): Promise<PdfPreviewResult> {
  if (!confirmation) {
    return {
      ok: false,
      reason: "confirmation_required",
      message: 'É preciso confirmar: "Confirmo que estes arquivos correspondem à prova e ao gabarito oficial da mesma aplicação/caderno."',
    };
  }

  const identityResult = validateExamIdentityInput(identityInput);
  if (!identityResult.ok) return { ok: false, reason: "invalid_identity", errors: identityResult.errors, message: "Identidade do exame inválida." };
  const identity = identityResult.identity!;

  if (examBytes.byteLength > PDF_EXAM_MAX_BYTES) return { ok: false, reason: "too_large", message: `PDF da prova excede o limite de ${PDF_EXAM_MAX_BYTES} bytes.` };
  if (answerKeyBytes.byteLength > PDF_ANSWER_KEY_MAX_BYTES) return { ok: false, reason: "too_large", message: `PDF do gabarito excede o limite de ${PDF_ANSWER_KEY_MAX_BYTES} bytes.` };

  // Seção 22 da ordem — o fingerprint tem que ser calculado ANTES de
  // qualquer chamada a `extractPdfPages`: o pdf.js entrega o `data` de
  // entrada ao "fake worker" por uma porta que segue a mesma semântica de
  // transferência de ArrayBuffer de um Worker real — o buffer de origem
  // pode ficar DETACHED (esvaziado) depois da chamada. Calcular o hash
  // depois produziria o hash de um buffer vazio (bug encontrado e corrigido
  // nesta sprint via teste de integração real, nunca só assumido).
  const examFingerprint = await sha256HexOfBytes(examBytes);
  const answerKeyFingerprint = await sha256HexOfBytes(answerKeyBytes);

  const examExtract = await extractPdfPages(examBytes);
  if (!examExtract.ok) {
    if (examExtract.reason === "needs_ocr") return { ok: false, reason: "needs_ocr_exam", message: examExtract.message };
    if (examExtract.reason === "too_many_pages") return { ok: false, reason: "too_large", message: examExtract.message };
    return { ok: false, reason: "invalid_exam", message: examExtract.message };
  }

  const answerKeyExtract = await extractPdfPages(answerKeyBytes);
  if (!answerKeyExtract.ok) {
    if (answerKeyExtract.reason === "needs_ocr") return { ok: false, reason: "needs_ocr_answer_key", message: answerKeyExtract.message };
    if (answerKeyExtract.reason === "too_many_pages") return { ok: false, reason: "too_large", message: answerKeyExtract.message };
    return { ok: false, reason: "invalid_answer_key", message: answerKeyExtract.message };
  }

  const { questions: rawQuestions, globalWarnings: segmentationWarnings } = segmentExamQuestions(examExtract.pages);
  if (rawQuestions.length > PDF_MAX_QUESTIONS_PER_BATCH) {
    return { ok: false, reason: "too_many_questions", message: `Foram detectadas ${rawQuestions.length} questões, acima do limite de ${PDF_MAX_QUESTIONS_PER_BATCH}.` };
  }

  const answerKeyPagesLines = await fingerprintPagesText(answerKeyExtract.pages);
  const answerKeyParse = parseAnswerKeyFromPageLines(answerKeyPagesLines);
  const answerKey = answerKeyParse.answers ?? new Map<number, AnswerLetter>();

  // Seção 22 da ordem — pré-passo puro (sem D1) para coletar candidatos,
  // MESMO padrão de importValidationContext.ts (CSV/ZIP): resolve a
  // existência de código/fingerprint em consultas EM LOTE, nunca uma
  // consulta por questão.
  const candidateCodes = rawQuestions.map((q) => buildPdfEnemQuestionCode(identity, q.originalNumber));
  const existingCodes = await queryExistingCodes(db, candidateCodes);
  // Fingerprints só são conhecidos depois de computar cada um (dentro de
  // buildPreviewQuestions) — para o PREVIEW, carregamos o conjunto de
  // fingerprints existentes sob demanda dentro da própria função, via uma
  // segunda consulta cujo filtro reaproveita os fingerprints calculados.
  const { items, globalWarnings: matchWarnings } = await buildPreviewQuestions(rawQuestions, answerKey, identity, existingCodes, new Set());
  const existingFingerprints = await queryExistingFingerprints(db, items.map((i) => i.fingerprint));
  // Segunda passada — agora com os fingerprints existentes reais — nunca
  // uma consulta por questão, sempre 1 consulta em lote adicional.
  const finalResult = await buildPreviewQuestions(rawQuestions, answerKey, identity, existingCodes, existingFingerprints);

  const globalWarnings = [...segmentationWarnings, ...matchWarnings, ...answerKeyParse.errors];

  const payload: PdfBatchPayload = {
    sourceKind: "pdf_enem",
    identity,
    examFingerprint,
    answerKeyFingerprint,
    questions: finalResult.items,
  };

  const payloadJson = JSON.stringify(payload);
  if (!isPayloadWithinBatchLimit(payloadJson)) {
    return { ok: false, reason: "payload_too_large", message: PAYLOAD_TOO_LARGE_MESSAGE };
  }

  const readyRows = finalResult.items.filter((q) => q.canApply).map((q) => ({ alternativas: q.alternatives, padroes: [{}], tags: [] as string[] }));
  const plannedStatements = plannedD1StatementCountForRows(readyRows);
  if (plannedStatements > IMPORT_BATCH_MAX_D1_STATEMENTS) {
    return {
      ok: false,
      reason: "too_many_statements",
      message: `Esta prévia geraria ${plannedStatements} operações no banco de dados, acima do limite seguro de ${IMPORT_BATCH_MAX_D1_STATEMENTS}. Divida a importação (ex.: por bloco de dia) em pacotes menores.`,
    };
  }

  const batchId = newId();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 30).toISOString();
  const combinedInputFingerprint = await sha256HexOfBytes(new TextEncoder().encode(`${examFingerprint}:${answerKeyFingerprint}`));

  await insertImportBatch(db, {
    id: batchId,
    userId: actorUserId,
    rowCount: finalResult.items.length,
    validRowCount: finalResult.items.filter((q) => q.canApply).length,
    errorCount: finalResult.items.filter((q) => !q.canApply).length,
    payload: payloadJson,
    inputFingerprint: combinedInputFingerprint,
    expiresAt,
  });

  await recordAuditEvent(db, newId(), "editorial_question_import_previewed", actorUserId, {
    batchId,
    sourceKind: "pdf_enem",
    examYear: identity.year,
    examApplication: identity.application,
    examBooklet: identity.booklet,
    examPdfSha256: examFingerprint,
    answerKeyPdfSha256: answerKeyFingerprint,
    pageCount: examExtract.pageCount,
    detectedQuestionCount: finalResult.items.length,
    matchedAnswerCount: finalResult.items.filter((q) => q.correctAlternative !== null).length,
  });

  return {
    ok: true,
    batchId,
    examIdentity: identity,
    pageCount: examExtract.pageCount,
    detectedQuestionCount: finalResult.items.length,
    matchedAnswerCount: finalResult.items.filter((q) => q.correctAlternative !== null).length,
    questions: finalResult.items,
    globalWarnings,
    canApply: finalResult.items.some((q) => q.canApply),
    expiresAt,
  };
}

/* -------------------------------- Apply -------------------------------- */

export interface PdfApplySelectionEntry {
  originalNumber: number;
  patternPrincipalId: string;
}

export interface PdfApplyResult {
  ok: boolean;
  notFound?: boolean;
  expired?: boolean;
  invalid?: boolean;
  fingerprintMismatch?: boolean;
  identityMismatch?: boolean;
  alreadyApplied?: boolean;
  conflict?: boolean;
  conflictReason?: string;
  tooManyStatements?: boolean;
  message?: string;
  appliedCount?: number;
  questionIds?: string[];
}

function logPotentialConflict(context: string, error: unknown): void {
  console.error(`questionPdfImportService: ${context}`, { error: error instanceof Error ? error.message : String(error) });
}

export async function applyPdf(
  db: D1Database,
  actorUserId: string,
  batchId: string,
  examBytes: Uint8Array,
  answerKeyBytes: Uint8Array,
  identityInput: ExamIdentityInput,
  selection: PdfApplySelectionEntry[]
): Promise<PdfApplyResult> {
  const batch = await findImportBatch(db, batchId);
  if (!batch || batch.user_id !== actorUserId) return { ok: false, notFound: true };

  let payload: PdfBatchPayload;
  try {
    const parsed = JSON.parse(batch.payload) as unknown;
    if (typeof parsed !== "object" || parsed === null || (parsed as PdfBatchPayload).sourceKind !== "pdf_enem") return { ok: false, invalid: true };
    payload = parsed as PdfBatchPayload;
  } catch {
    return { ok: false, invalid: true };
  }

  if (batch.status === "applied") {
    const items = await listImportItems(db, batchId);
    return { ok: true, alreadyApplied: true, questionIds: items.map((i) => i.question_id).filter((id): id is string => id !== null) };
  }
  if (batch.status !== "previewed") return { ok: false, invalid: true };
  if (new Date(batch.expires_at).getTime() < Date.now()) return { ok: false, expired: true };

  const identityResult = validateExamIdentityInput(identityInput);
  if (!identityResult.ok) return { ok: false, invalid: true };
  if (!examIdentitiesCompatible(identityResult.identity!, payload.identity)) return { ok: false, identityMismatch: true };

  // Seção 10/22 da ordem — o servidor NUNCA confia nos PDFs "reenviados"
  // sem provar que são byte-a-byte os MESMOS que geraram este batchId.
  const examFingerprint = await sha256HexOfBytes(examBytes);
  const answerKeyFingerprint = await sha256HexOfBytes(answerKeyBytes);
  if (examFingerprint !== payload.examFingerprint || answerKeyFingerprint !== payload.answerKeyFingerprint) {
    return { ok: false, fingerprintMismatch: true };
  }

  if (selection.length === 0) return { ok: false, invalid: true, message: "Nenhuma questão selecionada para aplicar." };

  // Re-extrai e re-segmenta do zero — nunca confia no payload persistido
  // como fonte de verdade do CONTEÚDO, só como o que o editor revisou;
  // recalcula tudo a partir dos bytes revalidados acima (seção 20: "valida
  // novamente... gabarito, 5 alternativas").
  const examExtract = await extractPdfPages(examBytes);
  if (!examExtract.ok) return { ok: false, invalid: true };
  const answerKeyExtract = await extractPdfPages(answerKeyBytes);
  if (!answerKeyExtract.ok) return { ok: false, invalid: true };

  const { questions: rawQuestions } = segmentExamQuestions(examExtract.pages);
  const answerKeyPagesLines = await fingerprintPagesText(answerKeyExtract.pages);
  const { answers: answerKey } = parseAnswerKeyFromPageLines(answerKeyPagesLines);

  const candidateCodes = rawQuestions.map((q) => buildPdfEnemQuestionCode(payload.identity, q.originalNumber));
  const existingCodes = await queryExistingCodes(db, candidateCodes);
  const preliminary = await buildPreviewQuestions(rawQuestions, answerKey ?? new Map(), payload.identity, existingCodes, new Set());
  const existingFingerprints = await queryExistingFingerprints(db, preliminary.items.map((i) => i.fingerprint));
  const revalidated = await buildPreviewQuestions(rawQuestions, answerKey ?? new Map(), payload.identity, existingCodes, existingFingerprints);

  const byNumber = new Map(revalidated.items.map((q) => [q.originalNumber, q] as const));

  // Seção 14 da ordem — catálogo de padrões PUBLISHED, resolvido em UMA
  // consulta (nunca uma por questão selecionada).
  const patternIds = Array.from(new Set(selection.map((s) => s.patternPrincipalId)));
  const placeholders = patternIds.map(() => "?").join(", ");
  const publishedRows =
    patternIds.length > 0
      ? await db.prepare(`SELECT id FROM patterns WHERE editorial_status = 'published' AND id IN (${placeholders})`).bind(...patternIds).all<{ id: string }>()
      : { results: [] };
  const publishedPatternIds = new Set((publishedRows.results ?? []).map((r) => r.id));

  // Seção 21 da ordem — tudo ou nada: qualquer entrada da seleção que não
  // esteja `canApply` (ainda), ou sem padrão principal published válido,
  // bloqueia o LOTE INTEIRO. Nenhum apply parcial silencioso.
  const seenSelectionNumbers = new Set<number>();
  for (const entry of selection) {
    if (seenSelectionNumbers.has(entry.originalNumber)) return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber} selecionada mais de uma vez.` };
    seenSelectionNumbers.add(entry.originalNumber);

    const item = byNumber.get(entry.originalNumber);
    if (!item) return { ok: false, invalid: true, message: `Questão ${entry.originalNumber} não foi reconhecida nesta revalidação.` };
    if (!item.canApply) return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber} não está pronta para aplicar.` };
    if (!entry.patternPrincipalId || !publishedPatternIds.has(entry.patternPrincipalId)) {
      return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber} sem padrão principal published válido.` };
    }
  }

  const selectedRows = selection.map((entry) => {
    const item = byNumber.get(entry.originalNumber)!;
    const alternativas: AlternativeInput[] = item.alternatives.map((a) => ({
      letter: a.letter,
      text: a.text,
      isCorrect: a.letter === item.correctAlternative,
      distractorExplanation: null,
    }));
    return { item, patternPrincipalId: entry.patternPrincipalId, alternativas, padroes: [{ patternId: entry.patternPrincipalId, role: "principal" as const }], tags: [] as string[] };
  });

  const plannedStatements = plannedD1StatementCountForRows(selectedRows);
  if (plannedStatements > IMPORT_BATCH_MAX_D1_STATEMENTS) {
    return { ok: false, tooManyStatements: true, message: `Esta seleção geraria ${plannedStatements} operações no banco de dados, acima do limite seguro de ${IMPORT_BATCH_MAX_D1_STATEMENTS}.` };
  }

  const examDescription = describeExamIdentity(payload.identity);
  const statements: D1PreparedStatement[] = [buildMarkBatchAppliedStatement(db, batchId)];
  const questionIds: string[] = [];

  for (const row of selectedRows) {
    const questionId = newId();
    questionIds.push(questionId);
    statements.push(
      buildInsertQuestionStatement(db, {
        id: questionId,
        code: row.item.code,
        enunciado: row.item.statement,
        resolucaoComentada: "",
        conteudo: "",
        subconteudo: "",
        habilidade: "",
        competencia: "",
        // Seção 15/16 da ordem — v1 nunca inventa dificuldade pedagógica
        // real; "media" é um default NEUTRO e explícito (nunca uma
        // afirmação factual), documentado aqui e no relatório final. A
        // Andreia pode revisar livremente no editor de questão.
        dificuldade: "media",
        origem: "oficial",
        prova: examDescription,
        ano: payload.identity.year,
        tempoEstimadoSegundos: null,
        tipoCalculo: "misto" as never,
        necessitaCalculadora: 0,
        autorId: actorUserId,
        // Seção 16 da ordem — nunca inventa titularidade/licença/"uso
        // livre"/"domínio público" sem base explícita: campos ficam vazios.
        titularDireitos: null,
        baseLicenca: null,
        textoAtribuicao: null,
        fingerprint: row.item.fingerprint,
        isLocalFixture: 0,
      })
    );
    statements.push(
      buildUpsertDnaStatement(db, questionId, {
        pista: "",
        estrategia: "",
        pegadinha: "",
        conteudoApoio: "",
        resolucao: "",
        atalho: null,
        aprendizadoErro: "",
      })
    );
    row.alternativas.forEach((alt, index) => statements.push(buildInsertAlternativeStatement(db, questionId, newId(), alt, index)));
    row.padroes.forEach((link) => statements.push(buildInsertPatternLinkStatement(db, questionId, newId(), link)));
    statements.push(
      buildConditionalHistoryStatement(db, {
        id: newId(),
        questionId,
        userId: actorUserId,
        action: "import_applied",
        fromStatus: null,
        toStatus: "draft",
        guardVersion: 1,
        versionAfter: 1,
        metadata: { batchId, sourceKind: "pdf_enem" },
      })
    );
    statements.push(buildInsertImportItemStatement(db, { id: newId(), batchId, rowNumber: row.item.originalNumber, code: row.item.code, questionId }));
  }

  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    logPotentialConflict("falha ao aplicar o lote PDF no D1", error);
    const maybeApplied = await findImportBatch(db, batchId);
    if (maybeApplied?.status === "applied") {
      const items = await listImportItems(db, batchId);
      return { ok: true, alreadyApplied: true, questionIds: items.map((i) => i.question_id).filter((id): id is string => id !== null) };
    }
    throw error;
  }

  const [markResult] = results;
  if (markResult.meta.changes !== 1) {
    const wasApplied = await findImportBatch(db, batchId);
    if (wasApplied?.status === "applied") {
      const items = await listImportItems(db, batchId);
      return { ok: true, alreadyApplied: true, questionIds: items.map((i) => i.question_id).filter((id): id is string => id !== null) };
    }
    return { ok: false, conflict: true };
  }

  await recordAuditEvent(db, newId(), "editorial_question_import_applied", actorUserId, {
    batchId,
    sourceKind: "pdf_enem",
    examYear: payload.identity.year,
    examApplication: payload.identity.application,
    examBooklet: payload.identity.booklet,
    examPdfSha256: examFingerprint,
    answerKeyPdfSha256: answerKeyFingerprint,
    appliedCount: selectedRows.length,
    // Seção 27 da ordem — "IDs criados" no audit; metadata só aceita
    // valores escalares (string/number/boolean), nunca array — junta como
    // string única (nunca enunciado/gabarito, só os IDs técnicos).
    questionIds: questionIds.join(","),
  });

  return { ok: true, appliedCount: selectedRows.length, questionIds };
}

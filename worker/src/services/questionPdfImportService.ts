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
   do cliente.

   Sprint 23 adicionou extração automática de imagem (via pdfjs-dist +
   pngEncoder.ts, sem canvas/dependência nova — ver pdfEnemVisualExtractor.ts).
   Conteúdo vetorial real (não-decorativo) continua permanentemente fora do
   apply automático nesta v1 (`visualReviewRequired=true`, cai em
   `needs_review` — Andreia cria a questão manualmente, seção 10 da ordem).

   Sprint 23.1 corrigiu a atomicidade do upload de imagem: R2 SEMPRE sobe
   ANTES de qualquer escrita no D1, e a criação da questão + `question_images`
   acontece no MESMO `db.batch()` — nunca duas transações separadas. Se
   algum `put()` falhar, nenhuma questão é criada (lote continua
   `previewed`, retry tenta de novo); se o D1 falhar depois dos puts,
   objetos R2 órfãos são aceitáveis (nunca apagados automaticamente — um
   retry concorrente pode estar usando a mesma key determinística), mas
   NUNCA existe uma questão criada sem sua imagem confirmada. */

import { extractPdfPages, PDF_MAX_BYTES } from "../lib/pdfEnemExtractor";
import { segmentExamQuestions, MAX_QUESTION_NUMBER, MIN_QUESTION_NUMBER, type RawQuestionCandidate, type QuestionSlotLocation } from "../lib/pdfEnemSegmenter";
import { parseAnswerKeyFromPages, type AnswerLetter } from "../lib/pdfEnemAnswerKey";
import type { OcrPageInput } from "../lib/pdfEnemOcrModel";
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
import {
  checkDocumentIdentity,
  detectAnswerKeyDocumentIdentity,
  detectExamDocumentIdentity,
  type DocumentIdentityCheckResult,
  type DetectedDocumentIdentity,
} from "../lib/pdfEnemDocumentIdentity";
import { sha256HexOfBytes } from "../lib/crypto";
import { computeQuestionFingerprint } from "../lib/fingerprint";
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
import {
  validateImageAltText,
  buildR2AssetKey,
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_IMAGES_PER_QUESTION,
  QUESTION_TEXT_MAX_LENGTH,
  QUESTION_ALTERNATIVE_LETTERS,
  type QuestionAlternativeLetter,
} from "../lib/questionsValidation";
import { sniffImageMimeType } from "../lib/imageSniffing";
import { buildStandaloneInsertImageStatement, buildGuardedImageAuditStatement } from "../repositories/questionRepository";
import type { RawVisualElement, VisualPlacementCandidate } from "../lib/pdfEnemVisualModel";
import { MAX_TOTAL_VISUAL_BYTES_PER_BATCH } from "../lib/pdfEnemVisualModel";

function newId(): string {
  return crypto.randomUUID();
}

/* Seção 24 da ordem — limites explícitos, fail-closed. */
export const PDF_EXAM_MAX_BYTES = PDF_MAX_BYTES; // 40MB
export const PDF_ANSWER_KEY_MAX_BYTES = 5 * 1024 * 1024; // 5MB — gabarito é um documento pequeno.
export const PDF_MAX_QUESTIONS_PER_BATCH = MAX_QUESTION_NUMBER; // mesmo teto estrutural do segmentador (200).

/* Sprint 23, seção 3 da ordem — `RawVisualElement.pngBytes` NUNCA é
 *  serializado no payload persistido (`question_import_batches.payload`
 *  precisa continuar leve — ver `isPayloadWithinBatchLimit`) nem reaproveitado
 *  como fonte de verdade depois do preview: o apply sempre re-deriva os
 *  bytes do zero a partir dos PDFs reenviados (mesmo princípio já usado
 *  para texto/gabarito). Os bytes só existem, brevemente, em memória:
 *  (a) dentro da resposta HTTP do preview, como thumbnail base64 (nunca
 *  gravados); (b) durante o apply, para upload real no R2 (seção 2 da
 *  ordem Sprint 23.1 — R2 SEMPRE antes do D1; ver `applyPdf` — reaproveita
 *  os mesmos blocos de escrita de `question_images`/auditoria de
 *  questionRepository.ts usados pelo resto do Banco de Questões, nunca
 *  `addQuestionImage()` diretamente, que assume a questão já existente). */
export type PersistableVisualElement = Omit<RawVisualElement, "pngBytes">;
export type HttpVisualElement = Omit<RawVisualElement, "pngBytes"> & { thumbnailDataUri?: string };

function toPersistableVisualElement(el: RawVisualElement): PersistableVisualElement {
  const { pngBytes: _pngBytes, ...rest } = el;
  return rest;
}

/** Só para a RESPOSTA HTTP do preview — nunca persistido. Imagens de
 *  questão real do ENEM são pequenas (a maior observada no PDF oficial
 *  usado nesta sprint: ~39KB de PNG) — v1 não faz miniaturização/resize
 *  (escopo reduzido e divulgado no relatório final), envia o PNG completo
 *  como data URI. */
function toHttpVisualElement(el: RawVisualElement): HttpVisualElement {
  const { pngBytes, ...rest } = el;
  if (!pngBytes) return rest;
  let binary = "";
  for (let i = 0; i < pngBytes.length; i++) binary += String.fromCharCode(pngBytes[i]);
  const base64 = btoa(binary);
  return { ...rest, thumbnailDataUri: `data:image/png;base64,${base64}` };
}

export interface PersistablePreviewQuestion extends Omit<PdfEnemPreviewQuestion, "visualElements"> {
  visualElements: PersistableVisualElement[];
}
export interface HttpPreviewQuestion extends Omit<PdfEnemPreviewQuestion, "visualElements"> {
  visualElements: HttpVisualElement[];
}

export function toPersistablePreviewQuestion(item: PdfEnemPreviewQuestion): PersistablePreviewQuestion {
  return { ...item, visualElements: item.visualElements.map(toPersistableVisualElement) };
}
export function toHttpPreviewQuestion(item: PdfEnemPreviewQuestion): HttpPreviewQuestion {
  return { ...item, visualElements: item.visualElements.map(toHttpVisualElement) };
}

export interface PdfBatchPayload {
  sourceKind: "pdf_enem";
  identity: ExamIdentity;
  examFingerprint: string;
  answerKeyFingerprint: string;
  questions: PersistablePreviewQuestion[];
  /** Seção 2/3 da ordem — identidade DETECTADA no texto dos dois PDFs,
   *  persistida para o apply poder revalidar a MESMA comparação (nunca
   *  confiando só no resultado do preview). */
  documentIdentityCheck: DocumentIdentityCheckResult;
}

export interface PdfPreviewResult {
  ok: boolean;
  batchId?: string;
  examIdentity?: ExamIdentity;
  documentIdentityCheck?: DocumentIdentityCheckResult;
  pageCount?: number;
  detectedQuestionCount?: number;
  matchedAnswerCount?: number;
  questions?: HttpPreviewQuestion[];
  globalWarnings?: string[];
  canApply?: boolean;
  expiresAt?: string;
  reason?: "needs_ocr_exam" | "needs_ocr_answer_key" | "invalid_exam" | "invalid_answer_key" | "too_large" | "too_many_questions" | "invalid_identity" | "payload_too_large" | "too_many_statements" | "confirmation_required";
  message?: string;
  errors?: string[];
  /** Sprint 24, seções 2/4 da ordem — só presente quando `reason` é
   *  `needs_ocr_exam`/`needs_ocr_answer_key`: números das páginas (1-based)
   *  que o cliente precisa renderizar e reconhecer via OCR antes de tentar
   *  a prévia de novo (desta vez enviando `examOcrPages`/`answerKeyOcrPages`). */
  pagesNeedingOcr?: number[];
}

export async function previewPdf(
  db: D1Database,
  actorUserId: string,
  examBytes: Uint8Array,
  answerKeyBytes: Uint8Array,
  identityInput: ExamIdentityInput,
  confirmation: boolean,
  /** Sprint 24, seções 2/4/9 da ordem — OCR reconhecido no CLIENTE para as
   *  páginas que `extractPdfPages` sinalizou como `needs_ocr` numa chamada
   *  anterior (fluxo em duas etapas: 1ª chamada sem `ocrPages` detecta
   *  quais páginas precisam; o cliente renderiza+reconhece SÓ essas
   *  páginas e reenvia). Ausente/vazio preserva 100% do comportamento
   *  anterior (nenhum PDF com camada de texto boa jamais aciona OCR). */
  examOcrPages: OcrPageInput[] = [],
  answerKeyOcrPages: OcrPageInput[] = []
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

  const examExtract = await extractPdfPages(examBytes, examOcrPages);
  if (!examExtract.ok) {
    if (examExtract.reason === "needs_ocr") {
      return { ok: false, reason: "needs_ocr_exam", message: examExtract.message, pagesNeedingOcr: examExtract.pagesNeedingOcr };
    }
    if (examExtract.reason === "too_many_pages") return { ok: false, reason: "too_large", message: examExtract.message };
    return { ok: false, reason: "invalid_exam", message: examExtract.message };
  }

  const answerKeyExtract = await extractPdfPages(answerKeyBytes, answerKeyOcrPages);
  if (!answerKeyExtract.ok) {
    if (answerKeyExtract.reason === "needs_ocr") {
      return { ok: false, reason: "needs_ocr_answer_key", message: answerKeyExtract.message, pagesNeedingOcr: answerKeyExtract.pagesNeedingOcr };
    }
    if (answerKeyExtract.reason === "too_many_pages") return { ok: false, reason: "too_large", message: answerKeyExtract.message };
    return { ok: false, reason: "invalid_answer_key", message: answerKeyExtract.message };
  }

  const { questions: rawQuestions, globalWarnings: segmentationWarnings } = segmentExamQuestions(examExtract.pages);
  if (rawQuestions.length > PDF_MAX_QUESTIONS_PER_BATCH) {
    return { ok: false, reason: "too_many_questions", message: `Foram detectadas ${rawQuestions.length} questões, acima do limite de ${PDF_MAX_QUESTIONS_PER_BATCH}.` };
  }

  const answerKeyParse = parseAnswerKeyFromPages(answerKeyExtract.pages);
  const answerKey = answerKeyParse.answers ?? new Map<number, AnswerLetter>();

  // Seção 2/3 da ordem — identidade DETECTADA no texto dos dois PDFs,
  // comparada em três vias (prova × gabarito × o que o editor confirmou
  // no campo "Caderno/cor"). Fail-closed: qualquer divergência REAL força
  // canApply=false no lote inteiro, mesmo que questões individuais
  // estejam estruturalmente prontas — nunca aplicável com identidade
  // documental suspeita.
  const examDocumentIdentity = detectExamDocumentIdentity(examExtract.pages);
  const answerKeyDocumentIdentity = detectAnswerKeyDocumentIdentity(answerKeyExtract.pages);
  const documentIdentityCheck = checkDocumentIdentity(examDocumentIdentity, answerKeyDocumentIdentity, identity);

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
  const { items, globalWarnings: matchWarnings } = await buildPreviewQuestions(
    rawQuestions, answerKey, identity, existingCodes, new Set(), examExtract.visualElements, examExtract.tabularPageNumbers
  );
  const existingFingerprints = await queryExistingFingerprints(db, items.map((i) => i.fingerprint));
  // Segunda passada — agora com os fingerprints existentes reais — nunca
  // uma consulta por questão, sempre 1 consulta em lote adicional.
  const finalResult = await buildPreviewQuestions(
    rawQuestions, answerKey, identity, existingCodes, existingFingerprints, examExtract.visualElements, examExtract.tabularPageNumbers
  );

  const globalWarnings = [
    ...segmentationWarnings,
    ...matchWarnings,
    ...answerKeyParse.errors,
    ...documentIdentityCheck.messages,
    ...examExtract.ocrWarnings,
    ...answerKeyExtract.ocrWarnings,
  ];

  const payload: PdfBatchPayload = {
    sourceKind: "pdf_enem",
    identity,
    examFingerprint,
    answerKeyFingerprint,
    questions: finalResult.items.map(toPersistablePreviewQuestion),
    documentIdentityCheck,
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
    documentIdentityCheck,
    pageCount: examExtract.pageCount,
    detectedQuestionCount: finalResult.items.length,
    matchedAnswerCount: finalResult.items.filter((q) => q.correctAlternative !== null).length,
    questions: finalResult.items.map(toHttpPreviewQuestion),
    globalWarnings,
    // Seção 3 da ordem — divergência documental real (ok=false) derruba
    // canApply do LOTE INTEIRO, mesmo com questões individualmente
    // prontas — nunca aplicável com identidade suspeita entre os PDFs.
    canApply: documentIdentityCheck.ok && finalResult.items.some((q) => q.canApply),
    expiresAt,
  };
}

/* -------------------------------- Apply -------------------------------- */

/** Seção 5/7 da ordem — correção editorial de uma questão `needs_review`
 *  por problema ESTRUTURAL (nunca de gabarito). `reviewedStatement`/
 *  `reviewedAlternatives` são OPCIONAIS: ausentes, a questão é aplicada
 *  como extraída; presentes, substituem enunciado/textos das alternativas
 *  e o backend revalida tudo do zero (nunca confia no texto editado sem
 *  checar). Deliberadamente SEM nenhum campo de gabarito/resposta correta
 *  aqui — a interface nem permite ao cliente enviar isso; ver seção 7:
 *  "preserva correctAlternative exclusivamente do gabarito oficial". */
export interface PdfReviewedAlternative {
  letter: "A" | "B" | "C" | "D" | "E";
  text: string;
}

/** Sprint 23, seção 8/9/10/11 da ordem — confirmação editorial de UMA
 *  imagem raster extraída automaticamente. `elementHash` identifica o
 *  elemento pelo hash dos PIXELS (`RawVisualElement.hash`, SHA-256 —
 *  nunca pelo `id` técnico, que é só um contador local à extração, não
 *  uma identidade de conteúdo). `placement` é a posição CONFIRMADA pelo
 *  editor (pode coincidir ou corrigir o palpite automático — nunca
 *  `"unknown"`: se o editor não sabe onde a imagem vai, a questão
 *  simplesmente não é selecionada para este apply). Alt text SEMPRE
 *  obrigatório e revalidado no backend (seção 10: "nunca aceitar 'imagem'/
 *  'figura'/'gráfico' como preenchimento automático NOSSO" — aqui não
 *  preenchemos nada automaticamente, só validamos o que o editor digitou). */
export interface PdfVisualConfirmationEntry {
  elementHash: string;
  /** Tipada com o universo COMPLETO (inclui "unknown") porque chega de
   *  entrada de rede não confiável — a rejeição explícita de "unknown"
   *  acontece em runtime no laço de validação abaixo, nunca só no tipo. */
  placement: VisualPlacementCandidate;
  altText: string;
}

export interface PdfApplySelectionEntry {
  originalNumber: number;
  patternPrincipalId: string;
  reviewedStatement?: string;
  reviewedAlternatives?: PdfReviewedAlternative[];
  visualConfirmations?: PdfVisualConfirmationEntry[];
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
  /** Sprint 23.1, seção 6 da ordem — soma real dos bytes finais de TODOS
   *  os PNGs que seriam enviados neste apply excede
   *  `MAX_TOTAL_VISUAL_BYTES_PER_BATCH`. Bloqueia ANTES de qualquer
   *  `put()` no R2 e antes de qualquer escrita no D1 — nunca um upload
   *  parcial. */
  visualBytesExceeded?: boolean;
  message?: string;
  appliedCount?: number;
  questionIds?: string[];
}

function logPotentialConflict(context: string, error: unknown): void {
  console.error(`questionPdfImportService: ${context}`, { error: error instanceof Error ? error.message : String(error) });
}

const REQUIRED_REVIEWED_LETTERS = ["A", "B", "C", "D", "E"] as const;

export interface ReviewEditResult {
  ok: boolean;
  item?: PdfEnemPreviewQuestion;
  reason?: string;
}

/** Seção 5/7 da ordem — aplica (quando presente) a correção editorial de
 *  enunciado/alternativas de UMA questão, revalidando do zero — nunca
 *  confia no texto editado sem checar de novo:
 *    - exatamente 5 alternativas, letras A-E únicas e na ordem certa;
 *    - nenhum texto vazio;
 *    - fingerprint RECALCULADO a partir do texto editado (nunca reaproveita
 *      o fingerprint da extração original);
 *    - `correctAlternative` NUNCA muda — vem exclusivamente do casamento
 *      já feito com o PDF de gabarito na revalidação (`item` de entrada),
 *      e a interface de entrada (`PdfApplySelectionEntry`) nem tem como
 *      carregar uma resposta correta alternativa.
 *  Sem `reviewedStatement`/`reviewedAlternatives`, devolve o item
 *  original sem tocar em nada. */
export async function applyReviewEdit(item: PdfEnemPreviewQuestion, entry: PdfApplySelectionEntry): Promise<ReviewEditResult> {
  if (entry.reviewedStatement === undefined && entry.reviewedAlternatives === undefined) {
    return { ok: true, item };
  }

  const statement = (entry.reviewedStatement ?? item.statement).trim();
  if (statement.length === 0) {
    return { ok: false, reason: `Questão ${item.originalNumber}: enunciado editado não pode ficar vazio.` };
  }

  const alternatives = entry.reviewedAlternatives ?? item.alternatives;
  if (alternatives.length !== 5 || alternatives.some((a, i) => a.letter !== REQUIRED_REVIEWED_LETTERS[i])) {
    return { ok: false, reason: `Questão ${item.originalNumber}: a correção precisa ter exatamente as 5 alternativas A-E, nesta ordem.` };
  }
  if (alternatives.some((a) => a.text.trim().length === 0)) {
    return { ok: false, reason: `Questão ${item.originalNumber}: nenhuma alternativa da correção pode ficar vazia.` };
  }

  // Fingerprint SEMPRE recalculado do conteúdo efetivo — nunca reaproveita
  // o da extração original quando o texto mudou. `isCorrect` sempre
  // false aqui (mesma convenção do resto do pipeline): o fingerprint
  // nunca depende de qual alternativa é a correta.
  const fingerprint = await computeQuestionFingerprint(
    statement,
    alternatives.map((a) => ({ letter: a.letter, text: a.text.trim(), isCorrect: false }))
  );

  return {
    ok: true,
    item: {
      ...item,
      statement,
      alternatives: alternatives.map((a) => ({ letter: a.letter, text: a.text.trim() })),
      fingerprint,
    },
  };
}

export async function applyPdf(
  db: D1Database,
  bucket: R2Bucket,
  actorUserId: string,
  batchId: string,
  examBytes: Uint8Array,
  answerKeyBytes: Uint8Array,
  identityInput: ExamIdentityInput,
  selection: PdfApplySelectionEntry[],
  /** Sprint 24 — o MESMO OCR reenviado pelo cliente (nunca refeito pelo
   *  worker, que nunca roda OCR — seção 30/31 da ordem): o apply precisa
   *  reproduzir exatamente a mesma fusão nativo+OCR do preview para
   *  re-segmentar e revalidar do zero (mesmo princípio de "nunca confia no
   *  preview persistido" já usado para o texto/gabarito). */
  examOcrPages: OcrPageInput[] = [],
  answerKeyOcrPages: OcrPageInput[] = []
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
  const examExtract = await extractPdfPages(examBytes, examOcrPages);
  if (!examExtract.ok) return { ok: false, invalid: true };
  const answerKeyExtract = await extractPdfPages(answerKeyBytes, answerKeyOcrPages);
  if (!answerKeyExtract.ok) return { ok: false, invalid: true };

  // Seção 3 da ordem — revalidado do ZERO a partir dos bytes reenviados
  // (nunca confia no `documentIdentityCheck` persistido no preview como
  // fonte de verdade final): qualquer divergência REAL entre os PDFs
  // bloqueia o apply, mesmo que o preview tenha permitido gerar a prévia.
  const examDocumentIdentity = detectExamDocumentIdentity(examExtract.pages);
  const answerKeyDocumentIdentity = detectAnswerKeyDocumentIdentity(answerKeyExtract.pages);
  const documentIdentityCheck = checkDocumentIdentity(examDocumentIdentity, answerKeyDocumentIdentity, payload.identity);
  if (!documentIdentityCheck.ok) {
    return { ok: false, conflict: true, conflictReason: documentIdentityCheck.messages.join(" ") };
  }

  const { questions: rawQuestions } = segmentExamQuestions(examExtract.pages);
  const { answers: answerKey } = parseAnswerKeyFromPages(answerKeyExtract.pages);

  const candidateCodes = rawQuestions.map((q) => buildPdfEnemQuestionCode(payload.identity, q.originalNumber));
  const existingCodes = await queryExistingCodes(db, candidateCodes);
  const preliminary = await buildPreviewQuestions(
    rawQuestions, answerKey ?? new Map(), payload.identity, existingCodes, new Set(), examExtract.visualElements, examExtract.tabularPageNumbers
  );
  const existingFingerprints = await queryExistingFingerprints(db, preliminary.items.map((i) => i.fingerprint));
  const revalidated = await buildPreviewQuestions(
    rawQuestions, answerKey ?? new Map(), payload.identity, existingCodes, existingFingerprints, examExtract.visualElements, examExtract.tabularPageNumbers
  );

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

  // Seção 5/7 da ordem — resolve a correção editorial (quando presente) de
  // CADA entrada ANTES de qualquer checagem de prontidão — nunca decide
  // "pronta"/"não pronta" com base no texto ORIGINAL quando um texto
  // corrigido foi enviado.
  const seenSelectionNumbers = new Set<number>();
  const effectiveByNumber = new Map<number, PdfEnemPreviewQuestion>();
  for (const entry of selection) {
    if (seenSelectionNumbers.has(entry.originalNumber)) return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber} selecionada mais de uma vez.` };
    seenSelectionNumbers.add(entry.originalNumber);

    const item = byNumber.get(entry.originalNumber);
    if (!item) return { ok: false, invalid: true, message: `Questão ${entry.originalNumber} não foi reconhecida nesta revalidação.` };

    const reviewResult = await applyReviewEdit(item, entry);
    if (!reviewResult.ok) return { ok: false, conflict: true, conflictReason: reviewResult.reason };
    effectiveByNumber.set(entry.originalNumber, reviewResult.item!);
  }

  // Fingerprints EFETIVOS (pós-correção, quando houve) que ainda não foram
  // checados contra o banco — a correção pode ter mudado o fingerprint
  // original já revalidado acima. Nunca uma consulta por questão: uma
  // única consulta em lote para os fingerprints que MUDARAM.
  const editedFingerprints = selection
    .map((entry) => effectiveByNumber.get(entry.originalNumber)!.fingerprint)
    .filter((fp) => !existingFingerprints.has(fp));
  const editedExistingFingerprints = await queryExistingFingerprints(db, editedFingerprints);
  const allExistingFingerprints = new Set([...existingFingerprints, ...editedExistingFingerprints]);

  // Seção 21 da ordem — tudo ou nada: qualquer entrada da seleção que não
  // esteja pronta (gabarito ausente, conteúdo visual, duplicidade — mesmo
  // após a correção editorial —, ou sem padrão principal published
  // válido) bloqueia o LOTE INTEIRO. Nenhum apply parcial silencioso.
  const seenFingerprintsInSelection = new Set<string>();
  for (const entry of selection) {
    const item = effectiveByNumber.get(entry.originalNumber)!;
    if (item.correctAlternative === null) {
      return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber}: gabarito ausente — nunca pode ser inferido, nunca escolhido manualmente.` };
    }
    if (item.visualReviewRequired) {
      return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber}: conteúdo visual não extraído — precisa ser criada manualmente com a imagem anexada.` };
    }
    // Seção 8/10/11 da ordem — uma questão com imagem raster extraída com
    // sucesso NUNCA aplica sem confirmação editorial explícita: exatamente
    // UMA `visualConfirmations` por imagem pendente (mesmo hash de
    // conteúdo), placement nunca "unknown", alt text validado do zero
    // (nunca confia em texto vindo do cliente sem checar de novo — mesmo
    // padrão de `validateImageAltText` usado pelo resto do pipeline de
    // mídia). Nenhuma imagem "sobrando" nem "faltando" é aceita.
    if (item.hasPendingVisualConfirmation) {
      const pendingHashes = item.visualElements.filter((v) => v.kind === "raster" && v.extractionStatus === "extracted").map((v) => v.hash);
      const confirmations = entry.visualConfirmations ?? [];
      if (confirmations.length !== pendingHashes.length) {
        return {
          ok: false,
          conflict: true,
          conflictReason: `Questão ${entry.originalNumber}: são ${pendingHashes.length} imagem(ns) pendente(s) de confirmação, ${confirmations.length} foram enviadas.`,
        };
      }
      const seenHashes = new Set<string>();
      for (const confirmation of confirmations) {
        if (!pendingHashes.includes(confirmation.elementHash) || seenHashes.has(confirmation.elementHash)) {
          return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber}: confirmação de imagem não corresponde a nenhuma imagem pendente desta questão.` };
        }
        seenHashes.add(confirmation.elementHash);
        if (confirmation.placement === "unknown" || !confirmation.placement) {
          return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber}: toda imagem confirmada precisa de um posicionamento (enunciado ou alternativa) — nunca "unknown".` };
        }
        const altTextResult = validateImageAltText(confirmation.altText);
        if (!altTextResult.ok) {
          return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber}: ${altTextResult.error}` };
        }
      }
    }
    if (existingCodes.has(item.code) || allExistingFingerprints.has(item.fingerprint) || seenFingerprintsInSelection.has(item.fingerprint)) {
      return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber}: duplicidade (código ou enunciado equivalente já existente).` };
    }
    seenFingerprintsInSelection.add(item.fingerprint);
    if (!entry.patternPrincipalId || !publishedPatternIds.has(entry.patternPrincipalId)) {
      return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber} sem padrão principal published válido.` };
    }
  }

  // Seção 2/8 da ordem (Sprint 23.1) — `questionId` é gerado AQUI (nunca
  // depende do D1) para poder ser usado tanto na chave R2 (determinística)
  // QUANTO no INSERT de `questions` mais adiante — sem isso não daria para
  // subir a imagem antes de a questão existir no banco.
  const selectedRows = selection.map((entry) => {
    const item = effectiveByNumber.get(entry.originalNumber)!;
    const alternativas: AlternativeInput[] = item.alternatives.map((a) => ({
      letter: a.letter,
      text: a.text,
      isCorrect: a.letter === item.correctAlternative,
      distractorExplanation: null,
    }));
    return {
      entry,
      item,
      questionId: newId(),
      patternPrincipalId: entry.patternPrincipalId,
      alternativas,
      padroes: [{ patternId: entry.patternPrincipalId, role: "principal" as const }],
      tags: [] as string[],
    };
  });

  /* ---------------------------------------------------------------------
     Sprint 23.1, seções 2/6/7 da ordem — plano de upload de imagem,
     construído ANTES de qualquer escrita (R2 ou D1). Cada entrada aqui
     representa UM `put()` que vai acontecer e UMA linha `question_images`
     que vai ser inserida no MESMO `db.batch()` da criação da questão —
     nunca duas transações separadas.
     --------------------------------------------------------------------- */
  interface ImageUploadPlan {
    originalNumber: number;
    questionId: string;
    imageId: string;
    assetRef: string;
    pngBytes: Uint8Array;
    mimeType: "image/png";
    sizeBytes: number;
    contentSha256: string;
    altText: string;
    placement: "enunciado" | "alternativa";
    alternativeLetter: QuestionAlternativeLetter | null;
  }

  const imagePlans: ImageUploadPlan[] = [];
  for (const row of selectedRows) {
    const confirmations = row.entry.visualConfirmations;
    if (!confirmations || confirmations.length === 0) continue;
    if (confirmations.length > MAX_IMAGES_PER_QUESTION) {
      return { ok: false, conflict: true, conflictReason: `Questão ${row.entry.originalNumber}: ${confirmations.length} imagens excede o limite de ${MAX_IMAGES_PER_QUESTION} por questão.` };
    }
    const elementsByHash = new Map(row.item.visualElements.map((el) => [el.hash, el] as const));
    for (const confirmation of confirmations) {
      const element = elementsByHash.get(confirmation.elementHash);
      if (!element || !element.pngBytes) {
        // Mesma exigência de "nunca confia no preview persistido" já usada
        // para texto/gabarito — se a re-extração desta chamada não
        // reproduziu o MESMO elemento confirmado, é uma divergência real
        // entre o que foi revisado e o que foi reenviado. Bloqueia o LOTE
        // INTEIRO, nunca um upload parcial silencioso.
        return {
          ok: false,
          conflict: true,
          conflictReason: `Questão ${row.entry.originalNumber}: imagem confirmada não foi re-derivada nesta aplicação (divergência entre o PDF revisado e o reenviado). Gere uma nova prévia.`,
        };
      }
      const sniffed = sniffImageMimeType(element.pngBytes);
      if (sniffed !== "image/png") {
        // Nunca deveria acontecer (nós mesmos geramos o PNG via
        // pngEncoder.ts) — defesa em profundidade contra um bug futuro do
        // encoder que produzisse bytes malformados; nunca sobe ao R2 nem
        // grava D1 um arquivo que não é realmente o que diz ser.
        return { ok: false, conflict: true, conflictReason: `Questão ${row.entry.originalNumber}: imagem gerada não passou na validação de formato real.` };
      }
      if (element.pngBytes.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
        return { ok: false, conflict: true, conflictReason: `Questão ${row.entry.originalNumber}: imagem excede o limite de ${MAX_IMAGE_UPLOAD_BYTES} bytes.` };
      }
      const imageId = newId();
      const [placementKind, letter] =
        confirmation.placement === "statement" ? (["enunciado", null] as const) : (["alternativa", confirmation.placement.replace("option_", "") as QuestionAlternativeLetter] as const);
      imagePlans.push({
        originalNumber: row.entry.originalNumber,
        questionId: row.questionId,
        imageId,
        assetRef: buildR2AssetKey(row.questionId, imageId, "image/png"),
        pngBytes: element.pngBytes,
        mimeType: "image/png",
        sizeBytes: element.pngBytes.byteLength,
        contentSha256: await sha256HexOfBytes(element.pngBytes),
        altText: confirmation.altText,
        placement: placementKind,
        alternativeLetter: letter,
      });
    }
  }

  // Seção 6 da ordem — soma dos bytes FÍSICOS finais dos PNGs (nunca o
  // tamanho do JSON da prévia, que é uma coisa completamente diferente),
  // checado ANTES de qualquer `put()` no R2 e ANTES de qualquer escrita
  // no D1.
  const totalVisualBytes = imagePlans.reduce((sum, plan) => sum + plan.sizeBytes, 0);
  if (totalVisualBytes > MAX_TOTAL_VISUAL_BYTES_PER_BATCH) {
    return {
      ok: false,
      visualBytesExceeded: true,
      message: `O total de imagens confirmadas (${totalVisualBytes} bytes) excede o limite de ${MAX_TOTAL_VISUAL_BYTES_PER_BATCH} bytes por aplicação.`,
    };
  }

  const plannedStatements = plannedD1StatementCountForRows(selectedRows, imagePlans.length * 2);
  if (plannedStatements > IMPORT_BATCH_MAX_D1_STATEMENTS) {
    return { ok: false, tooManyStatements: true, message: `Esta seleção geraria ${plannedStatements} operações no banco de dados, acima do limite seguro de ${IMPORT_BATCH_MAX_D1_STATEMENTS}.` };
  }

  /* ---------------------------------------------------------------------
     Seção 2/3/4 da ordem — R2 PRIMEIRO, sempre. Se QUALQUER `put()` falhar,
     paramos imediatamente e NUNCA tocamos o D1 — o lote continua
     `previewed`, um retry vai tentar os uploads de novo (put() é
     idempotente para a MESMA key/bytes). Objetos já enviados por puts
     ANTERIORES nesta mesma chamada NUNCA são apagados (seção 3: um retry
     concorrente pode estar usando a mesma key; órfão é sempre preferível a
     remover mídia válida de outra tentativa).
     --------------------------------------------------------------------- */
  for (const plan of imagePlans) {
    try {
      await bucket.put(plan.assetRef, plan.pngBytes, { httpMetadata: { contentType: plan.mimeType } });
    } catch (error) {
      logPotentialConflict(`falha ao subir imagem no R2 (questão ${plan.originalNumber}, key ${plan.assetRef})`, error);
      return {
        ok: false,
        conflict: true,
        conflictReason: `Questão ${plan.originalNumber}: falha ao enviar imagem ao armazenamento. Nenhuma questão foi criada — tente aplicar novamente.`,
      };
    }
  }

  const examDescription = describeExamIdentity(payload.identity);
  const statements: D1PreparedStatement[] = [buildMarkBatchAppliedStatement(db, batchId)];
  const questionIds: string[] = [];
  const imageStatementIndexByPlan: number[] = []; // índice, em `statements`, do INSERT de question_images de cada plano (mesma ordem de `imagePlans`) — usado depois para checar `changes===1`.

  for (const row of selectedRows) {
    const questionId = row.questionId;
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

    // Seção 2 da ordem — question_images entra no MESMO db.batch() da
    // criação da questão (nunca uma transação separada depois). O guard
    // interno de `buildStandaloneInsertImageStatement`/
    // `buildGuardedImageAuditStatement` (status editável / linha existe)
    // sempre passa aqui: a questão foi inserida statements ATRÁS, na MESMA
    // transação, e nunca é tocada por mais ninguém antes deste ponto.
    const plansForThisQuestion = imagePlans.filter((p) => p.questionId === questionId);
    for (let position = 0; position < plansForThisQuestion.length; position++) {
      const plan = plansForThisQuestion[position];
      statements.push(
        buildStandaloneInsertImageStatement(db, {
          id: plan.imageId,
          questionId,
          assetRef: plan.assetRef,
          altText: plan.altText,
          caption: null,
          position,
          placement: plan.placement,
          alternativeLetter: plan.alternativeLetter,
          storageKind: "r2",
          mimeType: plan.mimeType,
          sizeBytes: plan.sizeBytes,
          contentSha256: plan.contentSha256,
        })
      );
      imageStatementIndexByPlan.push(statements.length - 1);
      statements.push(
        buildGuardedImageAuditStatement(db, {
          id: newId(),
          imageId: plan.imageId,
          questionId,
          eventType: "editorial_question_image_added",
          userId: actorUserId,
          metadata: { questionId, imageId: plan.imageId, placement: plan.placement, storageKind: "r2", sourceKind: "pdf_enem" },
        })
      );
    }
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

  // Seção 5 da ordem — invariante estrutural: o batch inteiro já
  // comprometeu (chegamos até aqui), então TODO INSERT de question_images
  // e sua auditoria acoplada precisam ter afetado exatamente 1 linha cada
  // — o guard de status editável dessas duas statements SEMPRE é
  // verdadeiro aqui (a questão foi inserida statements atrás, na MESMA
  // transação, e nada mais a tocou). Se algum não bateu, é uma violação de
  // invariante real (nunca um resultado de negócio comum) — mesmo padrão
  // de `assertMutationAuditCoupling` já usado em questionMediaService.ts.
  for (const statementIndex of imageStatementIndexByPlan) {
    const insertChanges = results[statementIndex].meta.changes;
    const auditChanges = results[statementIndex + 1].meta.changes;
    if (insertChanges !== 1 || auditChanges !== 1) {
      throw new Error(
        `questionPdfImportService: invariante violada — INSERT de question_images (changes=${insertChanges}) ou sua auditoria (changes=${auditChanges}) não afetou exatamente 1 linha, mesmo após o batch de apply ter comprometido (batchId=${batchId}).`
      );
    }
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
    imageCount: imagePlans.length,
    // Seção 27 da ordem — "IDs criados" no audit; metadata só aceita
    // valores escalares (string/number/boolean), nunca array — junta como
    // string única (nunca enunciado/gabarito, só os IDs técnicos).
    questionIds: questionIds.join(","),
  });

  return { ok: true, appliedCount: selectedRows.length, questionIds };
}

/* ============================================================================
   Sprint 24.2 — Importador ENEM CLIENT-SIDE (Cloudflare Workers Free).

   Causa raiz confirmada em auditoria (incidente P1, cf-ray correlacionado
   com `outcome: "exceededCpu"` real do runtime): o plano Gratuito do
   Workers tem teto de CPU baixo demais para o parsing de PDF via pdf.js
   rodar dentro do Worker de forma confiável. Em vez de insistir nisso
   (proibido pela ordem desta sprint), o PDF inteiro passa a ser lido,
   extraído, segmentado, casado com o gabarito e consolidado 100% no
   NAVEGADOR (`src/lib/pdfEnemImport/pipeline.ts`, reaproveitando os MESMOS
   módulos puros de `worker/src/lib/pdfEnem*.ts` — nunca uma reimplementação
   divergente). O Worker aqui NUNCA mais abre um PDF neste fluxo — só
   recebe o resultado JÁ ESTRUTURADO e:
     (a) valida forma/limites de tudo (nunca confia cegamente);
     (b) roda a MESMA função `buildPreviewQuestions` já testada, agora com
         `existingCodes`/`existingFingerprints` reais do D1 (única coisa que
         o navegador não pode saber sozinho);
     (c) roda a MESMA `checkDocumentIdentity`, a partir da identidade
         BRUTA detectada (`DetectedDocumentIdentity`) em cada PDF pelo
         navegador — nunca aceita um resultado de comparação já pronto vindo
         do cliente.

   Seção 9 da ordem — LIMITAÇÃO CONHECIDA E ACEITA: como o Worker nunca
   recebe os bytes do PDF neste fluxo, ele NÃO TEM COMO PROVAR que
   `examQuestions`/`answerKey` realmente vieram do PDF declarado — só pode
   validar FORMA e CONSISTÊNCIA interna. `examSha256`/`answerKeySha256`
   são gravados só para AUDITORIA/rastreabilidade (nunca como prova
   criptográfica de conteúdo). Mitigação: só admin/editor autenticado
   (`requireEditorialActor`, já aplicado na rota) pode usar este importador
   — mesmo perímetro de confiança do resto do Banco de Questões. */

export interface PdfClientBatchPayload {
  sourceKind: "pdf_enem_client";
  identity: ExamIdentity;
  examSha256: string;
  answerKeySha256: string;
  processingMode: "client";
  parserVersion: string;
  pageCount: number;
  questions: PersistablePreviewQuestion[];
  documentIdentityCheck: DocumentIdentityCheckResult;
}

export interface PdfClientPreviewResult {
  ok: boolean;
  batchId?: string;
  examIdentity?: ExamIdentity;
  documentIdentityCheck?: DocumentIdentityCheckResult;
  pageCount?: number;
  detectedQuestionCount?: number;
  matchedAnswerCount?: number;
  questions?: HttpPreviewQuestion[];
  globalWarnings?: string[];
  canApply?: boolean;
  expiresAt?: string;
  reason?: "invalid_identity" | "invalid_payload" | "too_many_questions" | "payload_too_large" | "too_many_statements" | "confirmation_required";
  message?: string;
}

export interface PdfClientPreviewRawInput {
  identityInput: ExamIdentityInput;
  confirmation: boolean;
  examSha256: unknown;
  answerKeySha256: unknown;
  pageCount: unknown;
  parserVersion: unknown;
  examQuestions: unknown;
  answerKey: unknown;
  visualElements: unknown;
  examDetectedIdentity: unknown;
  answerKeyDetectedIdentity: unknown;
}

const CLIENT_SHA256_RE = /^[0-9a-f]{64}$/;
const CLIENT_PARSER_VERSION_MAX_LENGTH = 40;
const MAX_WARNINGS_PER_ITEM = 50;
const MAX_WARNING_LENGTH = 500;
const MAX_LOCATIONS_PER_SLOT = 40; // uma questão jamais cruza dezenas de páginas de verdade — teto generoso, nunca ilimitado.
const MAX_CLIENT_VISUAL_ELEMENTS = 2000; // documento real medido (2024, 32 páginas, após classificação global): 634 — folga ampla, nunca ilimitado.

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isValidWarningsArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= MAX_WARNINGS_PER_ITEM && v.every((w) => typeof w === "string" && w.length <= MAX_WARNING_LENGTH);
}

function validateDetectedIdentity(raw: unknown, field: string): { ok: true; value: DetectedDocumentIdentity } | { ok: false; message: string } {
  if (raw === null || typeof raw !== "object") return { ok: false, message: `${field} precisa ser um objeto.` };
  const r = raw as Record<string, unknown>;
  const value: DetectedDocumentIdentity = {};
  if (r.year !== undefined) {
    if (!Number.isInteger(r.year)) return { ok: false, message: `${field}.year inválido.` };
    value.year = r.year as number;
  }
  if (r.day !== undefined) {
    if (!Number.isInteger(r.day)) return { ok: false, message: `${field}.day inválido.` };
    value.day = r.day as number;
  }
  if (r.bookletNumber !== undefined) {
    if (!Number.isInteger(r.bookletNumber)) return { ok: false, message: `${field}.bookletNumber inválido.` };
    value.bookletNumber = r.bookletNumber as number;
  }
  if (r.color !== undefined) {
    if (typeof r.color !== "string" || r.color.length > 40) return { ok: false, message: `${field}.color inválido.` };
    value.color = r.color;
  }
  if (r.application !== undefined) {
    if (typeof r.application !== "string" || r.application.length > 100) return { ok: false, message: `${field}.application inválido.` };
    value.application = r.application;
  }
  if (r.lowConfidenceOcrSource !== undefined) {
    if (typeof r.lowConfidenceOcrSource !== "boolean") return { ok: false, message: `${field}.lowConfidenceOcrSource inválido.` };
    value.lowConfidenceOcrSource = r.lowConfidenceOcrSource;
  }
  return { ok: true, value };
}

function validateSlotLocations(raw: unknown, pageCount: number, field: string): { ok: true; value: QuestionSlotLocation[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: `${field}: precisa ser uma lista.` };
  if (raw.length > MAX_LOCATIONS_PER_SLOT) return { ok: false, message: `${field}: excede o limite de ${MAX_LOCATIONS_PER_SLOT} localizações.` };
  const result: QuestionSlotLocation[] = [];
  for (const entry of raw) {
    const e = entry as { pageNumber?: unknown; minY?: unknown; maxY?: unknown };
    if (!Number.isInteger(e.pageNumber) || (e.pageNumber as number) < 1 || (e.pageNumber as number) > pageCount) {
      return { ok: false, message: `${field}: pageNumber inválido.` };
    }
    if (!isFiniteNumber(e.minY) || !isFiniteNumber(e.maxY)) return { ok: false, message: `${field}: minY/maxY inválidos.` };
    result.push({ pageNumber: e.pageNumber as number, minY: e.minY, maxY: e.maxY });
  }
  return { ok: true, value: result };
}

function validateClientExamQuestions(raw: unknown, pageCount: number): { ok: true; value: RawQuestionCandidate[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: "examQuestions precisa ser uma lista." };
  if (raw.length === 0) return { ok: false, message: "Nenhuma questão reconhecida no PDF." };
  if (raw.length > PDF_MAX_QUESTIONS_PER_BATCH) return { ok: false, message: `Foram enviadas ${raw.length} questões, acima do limite de ${PDF_MAX_QUESTIONS_PER_BATCH}.` };

  const seenNumbers = new Set<number>();
  const result: RawQuestionCandidate[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") return { ok: false, message: "Questão malformada no payload." };
    const q = entry as Record<string, unknown>;
    if (!Number.isInteger(q.originalNumber) || (q.originalNumber as number) < MIN_QUESTION_NUMBER || (q.originalNumber as number) > MAX_QUESTION_NUMBER) {
      return { ok: false, message: "originalNumber inválido em uma das questões." };
    }
    const originalNumber = q.originalNumber as number;
    if (seenNumbers.has(originalNumber)) return { ok: false, message: `Número de questão ${originalNumber} duplicado no payload — a consolidação client-side precisa deduplicar antes de enviar.` };
    seenNumbers.add(originalNumber);

    if (!Number.isInteger(q.pageStart) || !Number.isInteger(q.pageEnd) || (q.pageStart as number) < 1 || (q.pageEnd as number) < (q.pageStart as number) || (q.pageEnd as number) > pageCount) {
      return { ok: false, message: `Questão ${originalNumber}: pageStart/pageEnd inválidos.` };
    }
    if (typeof q.statement !== "string" || q.statement.length > QUESTION_TEXT_MAX_LENGTH) {
      return { ok: false, message: `Questão ${originalNumber}: enunciado inválido ou excede o tamanho máximo.` };
    }
    if (!Array.isArray(q.alternatives) || q.alternatives.length > 5) {
      return { ok: false, message: `Questão ${originalNumber}: alternativas inválidas.` };
    }
    const alternatives: RawQuestionCandidate["alternatives"] = [];
    for (const alt of q.alternatives) {
      const a = alt as { letter?: unknown; text?: unknown };
      if (typeof a.letter !== "string" || !(QUESTION_ALTERNATIVE_LETTERS as readonly string[]).includes(a.letter)) {
        return { ok: false, message: `Questão ${originalNumber}: letra de alternativa inválida.` };
      }
      if (typeof a.text !== "string" || a.text.length > QUESTION_TEXT_MAX_LENGTH) {
        return { ok: false, message: `Questão ${originalNumber}: texto de alternativa inválido.` };
      }
      alternatives.push({ letter: a.letter as "A" | "B" | "C" | "D" | "E", text: a.text });
    }
    if (typeof q.hasVisualContentOnPages !== "boolean") return { ok: false, message: `Questão ${originalNumber}: hasVisualContentOnPages inválido.` };
    if (!isValidWarningsArray(q.warnings)) return { ok: false, message: `Questão ${originalNumber}: warnings inválidos.` };
    if (!Number.isInteger(q.rawLineCount) || (q.rawLineCount as number) < 0) {
      return { ok: false, message: `Questão ${originalNumber}: rawLineCount inválido.` };
    }
    const statementLocationsResult = validateSlotLocations(q.statementLocations, pageCount, `Questão ${originalNumber}: statementLocations`);
    if (!statementLocationsResult.ok) return statementLocationsResult;
    const alternativeLocations: RawQuestionCandidate["alternativeLocations"] = {};
    if (q.alternativeLocations !== null && typeof q.alternativeLocations === "object") {
      for (const [letter, locations] of Object.entries(q.alternativeLocations as Record<string, unknown>)) {
        if (!(QUESTION_ALTERNATIVE_LETTERS as readonly string[]).includes(letter)) continue; // chave desconhecida — nunca propagada.
        const locResult = validateSlotLocations(locations, pageCount, `Questão ${originalNumber}: alternativeLocations.${letter}`);
        if (!locResult.ok) return locResult;
        alternativeLocations[letter as "A" | "B" | "C" | "D" | "E"] = locResult.value;
      }
    }
    if (typeof q.hasOcrText !== "boolean") return { ok: false, message: `Questão ${originalNumber}: hasOcrText inválido.` };

    result.push({
      originalNumber,
      pageStart: q.pageStart as number,
      pageEnd: q.pageEnd as number,
      statement: q.statement,
      alternatives,
      hasVisualContentOnPages: q.hasVisualContentOnPages,
      warnings: q.warnings,
      rawLineCount: q.rawLineCount as number,
      statementLocations: statementLocationsResult.value,
      alternativeLocations,
      hasOcrText: q.hasOcrText,
    });
  }
  return { ok: true, value: result };
}

function validateClientAnswerKey(raw: unknown): { ok: true; value: Map<number, AnswerLetter> } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: "answerKey precisa ser uma lista de pares [número, letra]." };
  if (raw.length > MAX_QUESTION_NUMBER) return { ok: false, message: "answerKey excede o limite de entradas." };
  const map = new Map<number, AnswerLetter>();
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) return { ok: false, message: "Entrada de answerKey malformada." };
    const [num, letter] = entry as [unknown, unknown];
    if (!Number.isInteger(num) || (num as number) < MIN_QUESTION_NUMBER || (num as number) > MAX_QUESTION_NUMBER) {
      return { ok: false, message: "Número de questão inválido em answerKey." };
    }
    if (typeof letter !== "string" || !(QUESTION_ALTERNATIVE_LETTERS as readonly string[]).includes(letter)) {
      return { ok: false, message: "Letra de gabarito inválida." };
    }
    map.set(num as number, letter as AnswerLetter);
  }
  return { ok: true, value: map };
}

const VALID_VISUAL_STATUSES = ["extracted", "detected_not_extractable", "ambiguous", "ignored_decorative"] as const;
const VALID_PLACEMENT_CANDIDATES = ["statement", "option_A", "option_B", "option_C", "option_D", "option_E", "unknown"] as const;
const CLIENT_PNG_SHA256_RE = /^[a-f0-9]{64}$/;

/** Sprint 24.2, hardening pós-auditoria — o client-preview NUNCA MAIS
 *  recebe bytes de imagem (nem sniff de MIME, nem hash server-side): a
 *  causa raiz original do incidente P1 é CPU do Worker, e hashear ~104
 *  PNGs (SHA-256 de ~7,7MB somados) a cada preview reintroduzia
 *  exatamente o tipo de trabalho pesado que esta sprint existe para
 *  eliminar. `pngSha256`/`byteLength` agora são uma DECLARAÇÃO do
 *  navegador (calculada lá, dos bytes reais, na mesma fronteira de
 *  confiança de todo o resto deste payload — seção 2/9 da ordem) —
 *  validados aqui só por FORMA (regex de hash hex de 64 caracteres,
 *  inteiro positivo dentro do limite), nunca por prova. A prova de
 *  consistência real (bytes reenviados == bytes revisados no preview)
 *  acontece no APPLY, onde o Worker de fato recebe e re-hasheia os PNGs
 *  confirmados — ver `applyPdfFromClientPreview`. */
function validateClientVisualElements(raw: unknown, pageCount: number): { ok: true; value: RawVisualElement[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: "visualElements precisa ser uma lista." };
  if (raw.length > MAX_CLIENT_VISUAL_ELEMENTS) return { ok: false, message: `visualElements excede o limite de ${MAX_CLIENT_VISUAL_ELEMENTS} elementos.` };

  const seenIds = new Set<string>();
  const result: RawVisualElement[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") return { ok: false, message: "Elemento visual malformado." };
    const el = entry as Record<string, unknown>;
    if (typeof el.id !== "string" || !el.id || el.id.length > 100 || seenIds.has(el.id)) {
      return { ok: false, message: "Elemento visual com id inválido/duplicado." };
    }
    seenIds.add(el.id);
    if (!Number.isInteger(el.pageNumber) || (el.pageNumber as number) < 1 || (el.pageNumber as number) > pageCount) {
      return { ok: false, message: `Elemento visual ${el.id}: pageNumber inválido.` };
    }
    if (el.kind !== "raster" && el.kind !== "vector_diagram") return { ok: false, message: `Elemento visual ${el.id}: kind inválido.` };
    if (![el.x, el.y, el.width, el.height].every(isFiniteNumber)) return { ok: false, message: `Elemento visual ${el.id}: geometria inválida.` };
    if (typeof el.hash !== "string" || !el.hash || el.hash.length > 128) return { ok: false, message: `Elemento visual ${el.id}: hash inválido.` };
    if (typeof el.extractionStatus !== "string" || !(VALID_VISUAL_STATUSES as readonly string[]).includes(el.extractionStatus)) {
      return { ok: false, message: `Elemento visual ${el.id}: extractionStatus inválido.` };
    }
    if (typeof el.placementCandidate !== "string" || !(VALID_PLACEMENT_CANDIDATES as readonly string[]).includes(el.placementCandidate)) {
      return { ok: false, message: `Elemento visual ${el.id}: placementCandidate inválido.` };
    }
    if (!isValidWarningsArray(el.warnings)) return { ok: false, message: `Elemento visual ${el.id}: warnings inválidos.` };

    const kind = el.kind as "raster" | "vector_diagram";
    const extractionStatus = el.extractionStatus as RawVisualElement["extractionStatus"];
    let pngSha256: string | undefined;
    let mime: "image/png" | undefined;
    let byteLength: number | undefined;
    if (kind === "raster" && extractionStatus === "extracted") {
      if (typeof el.pngSha256 !== "string" || !CLIENT_PNG_SHA256_RE.test(el.pngSha256)) {
        return { ok: false, message: `Elemento visual ${el.id}: pngSha256 inválido (esperado hash hex de 64 caracteres).` };
      }
      if (!Number.isInteger(el.byteLength) || (el.byteLength as number) <= 0 || (el.byteLength as number) > MAX_IMAGE_UPLOAD_BYTES) {
        return { ok: false, message: `Elemento visual ${el.id}: byteLength inválido (esperado inteiro entre 1 e ${MAX_IMAGE_UPLOAD_BYTES} bytes).` };
      }
      pngSha256 = el.pngSha256;
      mime = "image/png";
      byteLength = el.byteLength as number;
    }

    result.push({
      id: el.id,
      pageNumber: el.pageNumber as number,
      kind,
      x: el.x as number,
      y: el.y as number,
      width: el.width as number,
      height: el.height as number,
      mime,
      byteLength,
      hash: el.hash,
      extractionStatus,
      placementCandidate: el.placementCandidate as VisualPlacementCandidate,
      warnings: el.warnings,
      pngSha256,
    });
  }
  return { ok: true, value: result };
}

/** Sprint 24.2, seção 10 da ordem — novo endpoint LEVE. Nunca abre um PDF;
 *  só valida o payload já processado no navegador e roda o mesmo
 *  `buildPreviewQuestions` de sempre, agora com `existingCodes`/
 *  `existingFingerprints` reais (única parte que o navegador não pode
 *  saber sozinho) e `checkDocumentIdentity` a partir da identidade BRUTA
 *  detectada em cada PDF (nunca aceita um resultado de comparação
 *  pré-pronto do cliente). */
export async function previewPdfFromClientPayload(db: D1Database, actorUserId: string, input: PdfClientPreviewRawInput): Promise<PdfClientPreviewResult> {
  if (!input.confirmation) {
    return {
      ok: false,
      reason: "confirmation_required",
      message: 'É preciso confirmar: "Confirmo que estes arquivos correspondem à prova e ao gabarito oficial da mesma aplicação/caderno."',
    };
  }

  const identityResult = validateExamIdentityInput(input.identityInput);
  if (!identityResult.ok) return { ok: false, reason: "invalid_identity", message: "Identidade do exame inválida." };
  const identity = identityResult.identity!;

  if (typeof input.examSha256 !== "string" || !CLIENT_SHA256_RE.test(input.examSha256)) {
    return { ok: false, reason: "invalid_payload", message: "examSha256 inválido (esperado SHA-256 hex de 64 caracteres)." };
  }
  if (typeof input.answerKeySha256 !== "string" || !CLIENT_SHA256_RE.test(input.answerKeySha256)) {
    return { ok: false, reason: "invalid_payload", message: "answerKeySha256 inválido (esperado SHA-256 hex de 64 caracteres)." };
  }
  if (!Number.isInteger(input.pageCount) || (input.pageCount as number) < 1 || (input.pageCount as number) > 220) {
    return { ok: false, reason: "invalid_payload", message: "pageCount inválido." };
  }
  const pageCount = input.pageCount as number;
  if (typeof input.parserVersion !== "string" || input.parserVersion.length === 0 || input.parserVersion.length > CLIENT_PARSER_VERSION_MAX_LENGTH) {
    return { ok: false, reason: "invalid_payload", message: "parserVersion inválido." };
  }

  const examQuestionsResult = validateClientExamQuestions(input.examQuestions, pageCount);
  if (!examQuestionsResult.ok) return { ok: false, reason: "invalid_payload", message: examQuestionsResult.message };
  if (examQuestionsResult.value.length > PDF_MAX_QUESTIONS_PER_BATCH) {
    return { ok: false, reason: "too_many_questions", message: `Foram detectadas ${examQuestionsResult.value.length} questões, acima do limite de ${PDF_MAX_QUESTIONS_PER_BATCH}.` };
  }

  const answerKeyResult = validateClientAnswerKey(input.answerKey);
  if (!answerKeyResult.ok) return { ok: false, reason: "invalid_payload", message: answerKeyResult.message };

  const visualElementsResult = validateClientVisualElements(input.visualElements, pageCount);
  if (!visualElementsResult.ok) return { ok: false, reason: "invalid_payload", message: visualElementsResult.message };

  const examDetectedResult = validateDetectedIdentity(input.examDetectedIdentity, "examDetectedIdentity");
  if (!examDetectedResult.ok) return { ok: false, reason: "invalid_payload", message: examDetectedResult.message };
  const answerKeyDetectedResult = validateDetectedIdentity(input.answerKeyDetectedIdentity, "answerKeyDetectedIdentity");
  if (!answerKeyDetectedResult.ok) return { ok: false, reason: "invalid_payload", message: answerKeyDetectedResult.message };

  // Mesma função pura já usada pelo fluxo PDF clássico — nunca um cálculo
  // de identidade paralelo/divergente.
  const documentIdentityCheck = checkDocumentIdentity(examDetectedResult.value, answerKeyDetectedResult.value, identity);

  const rawQuestions = examQuestionsResult.value;
  const answerKey = answerKeyResult.value;
  const visualElements = visualElementsResult.value;
  // Sprint 24.2 — `tabularPageNumbers` nunca existe neste fluxo (OCR/fusão
  // tabular é exclusividade do importador Worker-side clássico, seção 18
  // da ordem: escopo desta sprint é só o caminho 100% nativo/client-side).
  const tabularPageNumbers: number[] = [];

  const candidateCodes = rawQuestions.map((q) => buildPdfEnemQuestionCode(identity, q.originalNumber));
  const existingCodes = await queryExistingCodes(db, candidateCodes);
  const preliminary = await buildPreviewQuestions(rawQuestions, answerKey, identity, existingCodes, new Set(), visualElements, tabularPageNumbers);
  const existingFingerprints = await queryExistingFingerprints(db, preliminary.items.map((i) => i.fingerprint));
  const finalResult = await buildPreviewQuestions(rawQuestions, answerKey, identity, existingCodes, existingFingerprints, visualElements, tabularPageNumbers);

  const globalWarnings = [...finalResult.globalWarnings, ...documentIdentityCheck.messages];

  const payload: PdfClientBatchPayload = {
    sourceKind: "pdf_enem_client",
    identity,
    examSha256: input.examSha256,
    answerKeySha256: input.answerKeySha256,
    processingMode: "client",
    parserVersion: input.parserVersion,
    pageCount,
    questions: finalResult.items.map(toPersistablePreviewQuestion),
    documentIdentityCheck,
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
  const combinedInputFingerprint = await sha256HexOfBytes(new TextEncoder().encode(`${input.examSha256}:${input.answerKeySha256}`));

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
    sourceKind: "pdf_enem_client",
    processingMode: "client",
    parserVersion: input.parserVersion,
    examYear: identity.year,
    examApplication: identity.application,
    examBooklet: identity.booklet,
    examPdfSha256: input.examSha256,
    answerKeyPdfSha256: input.answerKeySha256,
    pageCount,
    detectedQuestionCount: finalResult.items.length,
    matchedAnswerCount: finalResult.items.filter((q) => q.correctAlternative !== null).length,
  });

  return {
    ok: true,
    batchId,
    examIdentity: identity,
    documentIdentityCheck,
    pageCount,
    detectedQuestionCount: finalResult.items.length,
    matchedAnswerCount: finalResult.items.filter((q) => q.correctAlternative !== null).length,
    questions: finalResult.items.map(toHttpPreviewQuestion),
    globalWarnings,
    canApply: documentIdentityCheck.ok && finalResult.items.some((q) => q.canApply),
    expiresAt,
  };
}

/** Sprint 24.2, seção 11/12 da ordem — apply do importador client-side.
 *  NUNCA reprocessa PDF (não recebe mais bytes de PDF neste fluxo — só os
 *  PNGs confirmados, quando houver). Confia no `payload` persistido no
 *  preview como fonte de verdade do CONTEÚDO (mesmo princípio já usado
 *  pelo apply do Pacote ZIP) — a única coisa revalidada do zero aqui é
 *  duplicidade (código/fingerprint no D1, que pode ter mudado desde o
 *  preview) e a integridade byte-a-byte de cada imagem reenviada
 *  (`pngSha256` calculado no preview × hash dos bytes recebidos agora). */
export async function applyPdfFromClientPreview(
  db: D1Database,
  bucket: R2Bucket,
  actorUserId: string,
  batchId: string,
  selection: PdfApplySelectionEntry[],
  imageBytesByHash: Map<string, Uint8Array>
): Promise<PdfApplyResult> {
  const batch = await findImportBatch(db, batchId);
  if (!batch || batch.user_id !== actorUserId) return { ok: false, notFound: true };

  let payload: PdfClientBatchPayload;
  try {
    const parsed = JSON.parse(batch.payload) as unknown;
    if (typeof parsed !== "object" || parsed === null || (parsed as PdfClientBatchPayload).sourceKind !== "pdf_enem_client") return { ok: false, invalid: true };
    payload = parsed as PdfClientBatchPayload;
  } catch {
    return { ok: false, invalid: true };
  }

  if (batch.status === "applied") {
    const items = await listImportItems(db, batchId);
    return { ok: true, alreadyApplied: true, questionIds: items.map((i) => i.question_id).filter((id): id is string => id !== null) };
  }
  if (batch.status !== "previewed") return { ok: false, invalid: true };
  if (new Date(batch.expires_at).getTime() < Date.now()) return { ok: false, expired: true };
  if (selection.length === 0) return { ok: false, invalid: true, message: "Nenhuma questão selecionada para aplicar." };

  // Seção 11 da ordem — o payload PERSISTIDO é a fonte de verdade do
  // conteúdo (nunca re-extraído — não há mais PDF para re-extrair). Só
  // duplicidade é revalidada do zero contra o D1 atual (pode ter mudado
  // desde o preview).
  const byNumber = new Map(payload.questions.map((q) => [q.originalNumber, q] as const));
  const candidateCodes = payload.questions.map((q) => q.code);
  const existingCodes = await queryExistingCodes(db, candidateCodes);
  const existingFingerprints = await queryExistingFingerprints(db, payload.questions.map((q) => q.fingerprint));

  const patternIds = Array.from(new Set(selection.map((s) => s.patternPrincipalId)));
  const placeholders = patternIds.map(() => "?").join(", ");
  const publishedRows =
    patternIds.length > 0
      ? await db.prepare(`SELECT id FROM patterns WHERE editorial_status = 'published' AND id IN (${placeholders})`).bind(...patternIds).all<{ id: string }>()
      : { results: [] };
  const publishedPatternIds = new Set((publishedRows.results ?? []).map((r) => r.id));

  const seenSelectionNumbers = new Set<number>();
  const effectiveByNumber = new Map<number, PersistablePreviewQuestion>();
  for (const entry of selection) {
    if (seenSelectionNumbers.has(entry.originalNumber)) return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber} selecionada mais de uma vez.` };
    seenSelectionNumbers.add(entry.originalNumber);
    const item = byNumber.get(entry.originalNumber);
    if (!item) return { ok: false, invalid: true, message: `Questão ${entry.originalNumber} não existe nesta prévia.` };

    // Seção 5/7 da ordem — correção editorial OPCIONAL, mesma disciplina
    // do fluxo clássico (fingerprint sempre recalculado do texto efetivo,
    // `correctAlternative` NUNCA muda).
    const reviewResult = await applyReviewEdit(item as unknown as PdfEnemPreviewQuestion, entry);
    if (!reviewResult.ok) return { ok: false, conflict: true, conflictReason: reviewResult.reason };
    effectiveByNumber.set(entry.originalNumber, reviewResult.item! as unknown as PersistablePreviewQuestion);
  }

  const editedFingerprints = selection.map((entry) => effectiveByNumber.get(entry.originalNumber)!.fingerprint).filter((fp) => !existingFingerprints.has(fp));
  const editedExistingFingerprints = await queryExistingFingerprints(db, editedFingerprints);
  const allExistingFingerprints = new Set([...existingFingerprints, ...editedExistingFingerprints]);

  const seenFingerprintsInSelection = new Set<string>();
  for (const entry of selection) {
    const item = effectiveByNumber.get(entry.originalNumber)!;
    if (item.correctAlternative === null) {
      return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber}: gabarito ausente — nunca pode ser inferido, nunca escolhido manualmente.` };
    }
    if (item.visualReviewRequired) {
      return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber}: conteúdo visual não extraído — precisa ser criada manualmente com a imagem anexada.` };
    }
    if (item.hasPendingVisualConfirmation) {
      const pendingHashes = item.visualElements.filter((v) => v.kind === "raster" && v.extractionStatus === "extracted").map((v) => v.hash);
      const confirmations = entry.visualConfirmations ?? [];
      if (confirmations.length !== pendingHashes.length) {
        return {
          ok: false,
          conflict: true,
          conflictReason: `Questão ${entry.originalNumber}: são ${pendingHashes.length} imagem(ns) pendente(s) de confirmação, ${confirmations.length} foram enviadas.`,
        };
      }
      const seenHashes = new Set<string>();
      for (const confirmation of confirmations) {
        if (!pendingHashes.includes(confirmation.elementHash) || seenHashes.has(confirmation.elementHash)) {
          return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber}: confirmação de imagem não corresponde a nenhuma imagem pendente desta questão.` };
        }
        seenHashes.add(confirmation.elementHash);
        if (confirmation.placement === "unknown" || !confirmation.placement) {
          return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber}: toda imagem confirmada precisa de um posicionamento (enunciado ou alternativa) — nunca "unknown".` };
        }
        const altTextResult = validateImageAltText(confirmation.altText);
        if (!altTextResult.ok) return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber}: ${altTextResult.error}` };
      }
    }
    if (existingCodes.has(item.code) || allExistingFingerprints.has(item.fingerprint) || seenFingerprintsInSelection.has(item.fingerprint)) {
      return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber}: duplicidade (código ou enunciado equivalente já existente).` };
    }
    seenFingerprintsInSelection.add(item.fingerprint);
    if (!entry.patternPrincipalId || !publishedPatternIds.has(entry.patternPrincipalId)) {
      return { ok: false, conflict: true, conflictReason: `Questão ${entry.originalNumber} sem padrão principal published válido.` };
    }
  }

  const selectedRows = selection.map((entry) => {
    const item = effectiveByNumber.get(entry.originalNumber)!;
    const alternativas: AlternativeInput[] = item.alternatives.map((a) => ({
      letter: a.letter,
      text: a.text,
      isCorrect: a.letter === item.correctAlternative,
      distractorExplanation: null,
    }));
    return {
      entry,
      item,
      questionId: newId(),
      patternPrincipalId: entry.patternPrincipalId,
      alternativas,
      padroes: [{ patternId: entry.patternPrincipalId, role: "principal" as const }],
      tags: [] as string[],
    };
  });

  /* Seção 9/12 da ordem — plano de upload de imagem. Diferença crucial em
     relação ao fluxo PDF clássico: os bytes NÃO são re-derivados de um PDF
     reenviado (não existe mais PDF aqui) — são os bytes reenviados AGORA
     pelo cliente, e a única prova de integridade possível é bater o
     SHA-256 desses bytes contra o `pngSha256` calculado no MOMENTO DO
     PREVIEW (nunca um valor declarado pelo cliente nesta chamada de
     apply). Diferente = bloqueia o lote inteiro, nunca um upload parcial. */
  interface ImageUploadPlan {
    originalNumber: number;
    questionId: string;
    imageId: string;
    assetRef: string;
    pngBytes: Uint8Array;
    mimeType: "image/png";
    sizeBytes: number;
    contentSha256: string;
    altText: string;
    placement: "enunciado" | "alternativa";
    alternativeLetter: QuestionAlternativeLetter | null;
  }

  const imagePlans: ImageUploadPlan[] = [];
  for (const row of selectedRows) {
    const confirmations = row.entry.visualConfirmations;
    if (!confirmations || confirmations.length === 0) continue;
    if (confirmations.length > MAX_IMAGES_PER_QUESTION) {
      return { ok: false, conflict: true, conflictReason: `Questão ${row.entry.originalNumber}: ${confirmations.length} imagens excede o limite de ${MAX_IMAGES_PER_QUESTION} por questão.` };
    }
    const elementsByHash = new Map(row.item.visualElements.map((el) => [el.hash, el] as const));
    for (const confirmation of confirmations) {
      const element = elementsByHash.get(confirmation.elementHash);
      if (!element || !element.pngSha256) {
        return {
          ok: false,
          conflict: true,
          conflictReason: `Questão ${row.entry.originalNumber}: imagem confirmada não existe nesta prévia (persistida no preview). Gere uma nova prévia.`,
        };
      }
      const receivedBytes = imageBytesByHash.get(confirmation.elementHash);
      if (!receivedBytes) {
        return { ok: false, conflict: true, conflictReason: `Questão ${row.entry.originalNumber}: arquivo de imagem não foi reenviado no apply.` };
      }
      const receivedSha256 = await sha256HexOfBytes(receivedBytes);
      if (receivedSha256 !== element.pngSha256) {
        return {
          ok: false,
          conflict: true,
          conflictReason: `Questão ${row.entry.originalNumber}: a imagem reenviada não é byte-a-byte igual à revisada no preview. Gere uma nova prévia.`,
        };
      }
      const sniffed = sniffImageMimeType(receivedBytes);
      if (sniffed !== "image/png") {
        return { ok: false, conflict: true, conflictReason: `Questão ${row.entry.originalNumber}: imagem reenviada não passou na validação de formato real.` };
      }
      if (receivedBytes.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
        return { ok: false, conflict: true, conflictReason: `Questão ${row.entry.originalNumber}: imagem excede o limite de ${MAX_IMAGE_UPLOAD_BYTES} bytes.` };
      }
      const imageId = newId();
      const [placementKind, letter] =
        confirmation.placement === "statement" ? (["enunciado", null] as const) : (["alternativa", confirmation.placement.replace("option_", "") as QuestionAlternativeLetter] as const);
      imagePlans.push({
        originalNumber: row.entry.originalNumber,
        questionId: row.questionId,
        imageId,
        assetRef: buildR2AssetKey(row.questionId, imageId, "image/png"),
        pngBytes: receivedBytes,
        mimeType: "image/png",
        sizeBytes: receivedBytes.byteLength,
        contentSha256: receivedSha256,
        altText: confirmation.altText,
        placement: placementKind,
        alternativeLetter: letter,
      });
    }
  }

  const totalVisualBytes = imagePlans.reduce((sum, plan) => sum + plan.sizeBytes, 0);
  if (totalVisualBytes > MAX_TOTAL_VISUAL_BYTES_PER_BATCH) {
    return {
      ok: false,
      visualBytesExceeded: true,
      message: `O total de imagens confirmadas (${totalVisualBytes} bytes) excede o limite de ${MAX_TOTAL_VISUAL_BYTES_PER_BATCH} bytes por aplicação.`,
    };
  }

  const plannedStatements = plannedD1StatementCountForRows(selectedRows, imagePlans.length * 2);
  if (plannedStatements > IMPORT_BATCH_MAX_D1_STATEMENTS) {
    return { ok: false, tooManyStatements: true, message: `Esta seleção geraria ${plannedStatements} operações no banco de dados, acima do limite seguro de ${IMPORT_BATCH_MAX_D1_STATEMENTS}.` };
  }

  // Seção 11 da ordem — R2 SEMPRE primeiro, mesma disciplina de sempre
  // (Sprint 23.1): qualquer falha aqui nunca toca o D1, lote continua
  // `previewed`, retry reenvia (put() idempotente para a mesma key/bytes).
  for (const plan of imagePlans) {
    try {
      await bucket.put(plan.assetRef, plan.pngBytes, { httpMetadata: { contentType: plan.mimeType } });
    } catch (error) {
      logPotentialConflict(`falha ao subir imagem no R2 (questão ${plan.originalNumber}, key ${plan.assetRef})`, error);
      return {
        ok: false,
        conflict: true,
        conflictReason: `Questão ${plan.originalNumber}: falha ao enviar imagem ao armazenamento. Nenhuma questão foi criada — tente aplicar novamente.`,
      };
    }
  }

  const examDescription = describeExamIdentity(payload.identity);
  const statements: D1PreparedStatement[] = [buildMarkBatchAppliedStatement(db, batchId)];
  const questionIds: string[] = [];
  const imageStatementIndexByPlan: number[] = [];

  for (const row of selectedRows) {
    const questionId = row.questionId;
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
        dificuldade: "media",
        origem: "oficial",
        prova: examDescription,
        ano: payload.identity.year,
        tempoEstimadoSegundos: null,
        tipoCalculo: "misto" as never,
        necessitaCalculadora: 0,
        autorId: actorUserId,
        titularDireitos: null,
        baseLicenca: null,
        textoAtribuicao: null,
        fingerprint: row.item.fingerprint,
        isLocalFixture: 0,
      })
    );
    statements.push(
      buildUpsertDnaStatement(db, questionId, { pista: "", estrategia: "", pegadinha: "", conteudoApoio: "", resolucao: "", atalho: null, aprendizadoErro: "" })
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
        metadata: { batchId, sourceKind: "pdf_enem_client" },
      })
    );
    statements.push(buildInsertImportItemStatement(db, { id: newId(), batchId, rowNumber: row.item.originalNumber, code: row.item.code, questionId }));

    const plansForThisQuestion = imagePlans.filter((p) => p.questionId === questionId);
    for (let position = 0; position < plansForThisQuestion.length; position++) {
      const plan = plansForThisQuestion[position];
      statements.push(
        buildStandaloneInsertImageStatement(db, {
          id: plan.imageId,
          questionId,
          assetRef: plan.assetRef,
          altText: plan.altText,
          caption: null,
          position,
          placement: plan.placement,
          alternativeLetter: plan.alternativeLetter,
          storageKind: "r2",
          mimeType: plan.mimeType,
          sizeBytes: plan.sizeBytes,
          contentSha256: plan.contentSha256,
        })
      );
      imageStatementIndexByPlan.push(statements.length - 1);
      statements.push(
        buildGuardedImageAuditStatement(db, {
          id: newId(),
          imageId: plan.imageId,
          questionId,
          eventType: "editorial_question_image_added",
          userId: actorUserId,
          metadata: { questionId, imageId: plan.imageId, placement: plan.placement, storageKind: "r2", sourceKind: "pdf_enem_client" },
        })
      );
    }
  }

  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    logPotentialConflict("falha ao aplicar o lote PDF client-side no D1", error);
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

  for (const statementIndex of imageStatementIndexByPlan) {
    const insertChanges = results[statementIndex].meta.changes;
    const auditChanges = results[statementIndex + 1].meta.changes;
    if (insertChanges !== 1 || auditChanges !== 1) {
      throw new Error(
        `questionPdfImportService: invariante violada (client apply) — INSERT de question_images (changes=${insertChanges}) ou sua auditoria (changes=${auditChanges}) não afetou exatamente 1 linha, mesmo após o batch de apply ter comprometido (batchId=${batchId}).`
      );
    }
  }

  await recordAuditEvent(db, newId(), "editorial_question_import_applied", actorUserId, {
    batchId,
    sourceKind: "pdf_enem_client",
    processingMode: "client",
    examYear: payload.identity.year,
    examApplication: payload.identity.application,
    examBooklet: payload.identity.booklet,
    examPdfSha256: payload.examSha256,
    answerKeyPdfSha256: payload.answerKeySha256,
    appliedCount: selectedRows.length,
    imageCount: imagePlans.length,
    questionIds: questionIds.join(","),
  });

  return { ok: true, appliedCount: selectedRows.length, questionIds };
}

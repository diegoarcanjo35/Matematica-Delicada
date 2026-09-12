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
import { segmentExamQuestions, MAX_QUESTION_NUMBER } from "../lib/pdfEnemSegmenter";
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

function toPersistablePreviewQuestion(item: PdfEnemPreviewQuestion): PersistablePreviewQuestion {
  return { ...item, visualElements: item.visualElements.map(toPersistableVisualElement) };
}
function toHttpPreviewQuestion(item: PdfEnemPreviewQuestion): HttpPreviewQuestion {
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

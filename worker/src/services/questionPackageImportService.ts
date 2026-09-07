/* Serviço de importação de Pacote ZIP (CSV V2 + imagens + manifest) —
   Sprint 19, seções 5-15 da ordem.

   Reaproveita deliberadamente:
     - a mesma tabela `question_import_batches`/`question_import_items` do
       CSV (Sprint 7) — o `payload` guarda um objeto `{sourceKind:'zip',
       rows, images}` em vez de um array simples (CSV), nenhuma migration
       nova precisou existir só para isto;
     - o parser/validador de linha CSV V2 (worker/src/lib/questionImportV2.ts)
       — o formato interno de cada linha (`ParsedImportRow`) é IDÊNTICO ao
       usado pelo CSV puro;
     - todo o pipeline de imagem da Sprint 18
       (worker/src/lib/imageSniffing.ts, buildR2AssetKey,
       buildStandaloneInsertImageStatement) — a mesma disciplina de
       sniffing real de MIME, extensão coerente, e o mesmo formato de chave
       R2 determinística `questions/<questionId>/<imageId>.<ext>`.

   Preview NUNCA escreve em `questions`/`question_images` nem no R2
   (seção 9) — só o registro técnico leve do lote, igual ao CSV. Apply só
   escreve no R2 depois de TUDO revalidado, e só escreve no D1 depois de
   TODOS os uploads R2 confirmados (seção 12) — nunca ao contrário. */

import { readZipSafely, PACKAGE_MAX_ENTRIES, PACKAGE_MAX_QUESTIONS_PER_PACKAGE, PACKAGE_MAX_SINGLE_FILE_BYTES, PACKAGE_MAX_TOTAL_UNCOMPRESSED_BYTES, PACKAGE_MAX_ZIP_COMPRESSED_BYTES, isSafeZipEntryPath, normalizeZipPathForComparison, type ZipEntry } from "../lib/zip";
import { parseAndValidateManifest, derivePositionKey, type ManifestImageEntry } from "../lib/manifest";
import { parseCsv } from "../lib/csv";
import { IMPORT_CSV_V2_HEADERS, parseAndValidateRowV2 } from "../lib/questionImportV2";
import { sha256HexOfBytes } from "../lib/crypto";
import { sniffImageMimeType, isDeclaredMimeConsistent } from "../lib/imageSniffing";
import {
  MAX_IMAGES_PER_QUESTION,
  MAX_IMAGE_UPLOAD_BYTES,
  buildR2AssetKey,
  type AllowedImageUploadMimeType,
} from "../lib/questionsValidation";
import { isPayloadWithinBatchLimit, PAYLOAD_TOO_LARGE_MESSAGE, IMPORT_BATCH_MAX_D1_STATEMENTS, plannedD1StatementCountForRows } from "../lib/importBatchLimits";
import { buildImportValidationContext, computeRowFingerprint, loadApplyRevalidationSets } from "../lib/importValidationContext";
import { recordAuditEvent } from "../repositories/auditRepository";
import { insertImportBatch, findImportBatch, buildInsertImportItemStatement, buildMarkBatchAppliedStatement, listImportItems } from "../repositories/questionImportRepository";
import {
  buildConditionalHistoryStatement,
  buildInsertAlternativeStatement,
  buildInsertPatternLinkStatement,
  buildInsertQuestionStatement,
  buildInsertTagStatement,
  buildStandaloneInsertImageStatement,
  buildUpsertDnaStatement,
} from "../repositories/questionRepository";
import type { ParsedImportRow } from "./questionImportService";

function newId(): string {
  return crypto.randomUUID();
}

export const PACKAGE_MAX_FILE_BYTES = PACKAGE_MAX_ZIP_COMPRESSED_BYTES;

const ALLOWED_ROOT_ENTRIES = new Set(["questoes.csv", "manifest.json"]);

/* Sprint 19.1, correção 4 da ordem — teto de QUANTIDADE de statements no
 * `db.batch()` do apply, calculado ANTES de qualquer upload R2.
 *
 * Sprint 19.2, seção 9/13 da ordem — a CONSTANTE e a FÓRMULA em si foram
 * generalizadas e movidas para worker/src/lib/importBatchLimits.ts (única
 * fonte, compartilhada por ZIP/CSV V2/CSV V1 — ver o comentário extenso lá
 * sobre a distinção entre o teto documentado de "queries por invocation"
 * da Cloudflare e este teto, que é uma regra CONSERVADORA DA APLICAÇÃO,
 * nunca um limite oficial). Reexportado aqui com os MESMOS nomes por
 * compatibilidade com os testes/chamadores já existentes desta sprint. */
export { IMPORT_BATCH_MAX_D1_STATEMENTS };

/** Conta EXATAMENTE o que `applyPackage` vai enviar a `db.batch()` — 1
 *  statement de marcação do lote + por questão (question, dna,
 *  alternativas, padrões, tags, history, item de importação) + 1 por
 *  imagem. Nunca uma estimativa — o mesmo cálculo usado no preview (para
 *  dar o erro cedo) e no apply (como gate final antes do R2). Fina camada
 *  sobre `plannedD1StatementCountForRows` (compartilhada com o CSV). */
export function plannedD1StatementCount(payload: PackageBatchPayload): number {
  return plannedD1StatementCountForRows(payload.rows, payload.images.length);
}

export interface PackageError {
  code?: string;
  file?: string;
  row?: number;
  field?: string;
  message: string;
}

export interface PackageImageRow {
  imageId: string;
  questionCode: string;
  path: string;
  placement: "enunciado" | "alternativa";
  alternativeLetter: string | null;
  altText: string;
  caption: string | null;
  position: number;
  mimeType: AllowedImageUploadMimeType;
  sizeBytes: number;
  contentSha256: string;
}

export interface PackageRow extends ParsedImportRow {
  questionId: string;
}

export interface PackageBatchPayload {
  sourceKind: "zip";
  rows: PackageRow[];
  images: PackageImageRow[];
}

export interface PackagePreviewQuestionSummary {
  code: string;
  enunciadoPreview: string;
  patternName: string | null;
  images: Array<{ imageId: string; path: string; placement: string; alternativeLetter: string | null; altText: string }>;
  status: "ready" | "error";
}

export interface PackagePreviewResult {
  ok: boolean;
  batchId?: string;
  rowCount?: number;
  validRowCount?: number;
  imageCount?: number;
  errorCount?: number;
  errors?: PackageError[];
  questions?: PackagePreviewQuestionSummary[];
  expiresAt?: string;
  message?: string;
}

function isValidUtf8(bytes: Uint8Array): { ok: true; text: string } | { ok: false } {
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) };
  } catch {
    return { ok: false };
  }
}

/* ------------------------------- Preview ------------------------------ */

export async function previewPackage(db: D1Database, actorUserId: string, zipBytes: Uint8Array): Promise<PackagePreviewResult> {
  const zipResult = await readZipSafely(zipBytes, {
    maxCompressedBytes: PACKAGE_MAX_ZIP_COMPRESSED_BYTES,
    maxTotalUncompressedBytes: PACKAGE_MAX_TOTAL_UNCOMPRESSED_BYTES,
    maxEntries: PACKAGE_MAX_ENTRIES,
    maxSingleFileBytes: PACKAGE_MAX_SINGLE_FILE_BYTES,
  });
  if (!zipResult.ok) return { ok: false, message: zipResult.error, errors: [{ message: zipResult.error! }] };

  const entries = zipResult.entries!;

  // Sprint 19, seção 7 da ordem — arquivo desconhecido no ZIP gera erro
  // bloqueante, nunca é silenciosamente ignorado. Único namespace extra
  // permitido é "imagens/"; qualquer outra coisa na raiz que não seja
  // exatamente um dos dois arquivos esperados é rejeitada.
  const structuralErrors: PackageError[] = [];
  for (const entry of entries) {
    if (ALLOWED_ROOT_ENTRIES.has(entry.path)) continue;
    if (entry.path.startsWith("imagens/") && isSafeZipEntryPath(entry.path)) continue;
    structuralErrors.push({ file: entry.path, message: `Arquivo não esperado no pacote: "${entry.path}".` });
  }

  const csvEntry = entries.find((e) => e.path === "questoes.csv");
  const manifestEntry = entries.find((e) => e.path === "manifest.json");
  if (!csvEntry) structuralErrors.push({ file: "questoes.csv", message: "Pacote sem questoes.csv." });
  if (!manifestEntry) structuralErrors.push({ file: "manifest.json", message: "Pacote sem manifest.json." });
  if (structuralErrors.length > 0) return { ok: false, errors: structuralErrors, message: "Pacote inválido." };

  const csvUtf8 = isValidUtf8(csvEntry!.bytes);
  if (!csvUtf8.ok) return { ok: false, errors: [{ file: "questoes.csv", message: "questoes.csv não está em UTF-8 válido." }] };

  const parseResult = parseCsv(csvUtf8.text, PACKAGE_MAX_QUESTIONS_PER_PACKAGE);
  if (!parseResult.ok) return { ok: false, errors: [{ file: "questoes.csv", message: parseResult.error ?? "CSV malformado." }] };

  const [headerRow, ...dataRows] = parseResult.rows!;
  const headerIndex: Record<string, number> = {};
  headerRow.forEach((h, i) => (headerIndex[h.trim()] = i));
  const missingHeaders = IMPORT_CSV_V2_HEADERS.filter((h) => !(h in headerIndex));
  if (missingHeaders.length > 0) {
    return { ok: false, errors: [{ file: "questoes.csv", message: `questoes.csv deve usar o formato CSV V2. Cabeçalho ausente: ${missingHeaders.join(", ")}.` }] };
  }
  if (dataRows.length === 0) return { ok: false, errors: [{ file: "questoes.csv", message: "questoes.csv sem linhas de dados." }] };
  if (dataRows.length > PACKAGE_MAX_QUESTIONS_PER_PACKAGE) {
    return { ok: false, errors: [{ file: "questoes.csv", message: `Pacote excede o limite de ${PACKAGE_MAX_QUESTIONS_PER_PACKAGE} questões.` }] };
  }

  // Sprint 19.2, seção 7 da ordem — MESMA estratégia em lote do CSV V2:
  // pré-passo puro (código+fingerprint de cada linha, sem D1) para montar
  // o contexto de validação em UMA leitura de catálogo + poucas consultas
  // chunked, nunca uma consulta por linha do questoes.csv.
  const codesToCheck: string[] = [];
  const fingerprintsToCheck: string[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    if (dataRows[i].length !== headerRow.length) continue;
    const { code: rowCode, fingerprint: rowFingerprint } = await computeRowFingerprint(dataRows[i], headerIndex);
    if (rowCode) codesToCheck.push(rowCode);
    if (rowFingerprint) fingerprintsToCheck.push(rowFingerprint);
  }
  const ctx = await buildImportValidationContext(db, codesToCheck, fingerprintsToCheck);

  const rowErrors: PackageError[] = [];
  const validRows: ParsedImportRow[] = [];
  const seenCodesInFile = new Map<string, number>();
  const seenFingerprintsInFile = new Map<string, number>();
  for (let i = 0; i < dataRows.length; i++) {
    const rowNumber = i + 2;
    if (dataRows[i].length !== headerRow.length) {
      rowErrors.push({ row: rowNumber, message: `Número de colunas (${dataRows[i].length}) difere do cabeçalho (${headerRow.length}).` });
      continue;
    }
    const { parsed, errors } = await parseAndValidateRowV2(ctx, dataRows[i], headerIndex, rowNumber, seenCodesInFile, seenFingerprintsInFile);
    if (errors.length > 0) rowErrors.push(...errors.map((e) => ({ row: e.row, field: e.field, message: e.message })));
    else if (parsed) validRows.push(parsed);
  }

  const manifestUtf8 = isValidUtf8(manifestEntry!.bytes);
  if (!manifestUtf8.ok) return { ok: false, errors: [...rowErrors, { file: "manifest.json", message: "manifest.json não está em UTF-8 válido." }] };
  const manifestResult = parseAndValidateManifest(manifestEntry!.bytes, MAX_IMAGES_PER_QUESTION);
  if (!manifestResult.ok) return { ok: false, errors: [...rowErrors, ...manifestResult.errors!] };
  const manifest = manifestResult.manifest!;

  const crossErrors: PackageError[] = [...rowErrors];
  const validCodesSet = new Set(validRows.map((r) => r.code));
  const imageEntriesByPath = new Map(entries.filter((e) => e.path.startsWith("imagens/")).map((e) => [e.path, e] as const));
  const referencedImagePaths = new Set<string>();

  interface CrossValidatedImage extends ManifestImageEntry {
    code: string;
    entry: ZipEntry;
    mimeType: AllowedImageUploadMimeType;
    sizeBytes: number;
    contentSha256: string;
  }
  const crossValidatedImages: CrossValidatedImage[] = [];

  for (const q of manifest.questions) {
    if (!validCodesSet.has(q.code)) {
      crossErrors.push({ code: q.code, message: `Questão "${q.code}" do manifest não existe (ou tem erro) em questoes.csv.` });
      continue;
    }
    for (const img of q.images) {
      referencedImagePaths.add(normalizeZipPathForComparison(img.file));
      const entry = imageEntriesByPath.get(img.file);
      if (!entry) {
        crossErrors.push({ code: q.code, file: img.file, message: `Imagem "${img.file}" referenciada no manifest mas ausente do ZIP.` });
        continue;
      }
      if (entry.bytes.byteLength === 0) {
        crossErrors.push({ code: q.code, file: img.file, message: `Imagem "${img.file}" está vazia.` });
        continue;
      }
      if (entry.bytes.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
        crossErrors.push({ code: q.code, file: img.file, message: `Imagem "${img.file}" excede o limite de ${MAX_IMAGE_UPLOAD_BYTES} bytes.` });
        continue;
      }
      const extensionLower = (img.file.split(".").pop() ?? "").toLowerCase();
      if (extensionLower === "svg") {
        crossErrors.push({ code: q.code, file: img.file, message: `Imagem "${img.file}": SVG não é aceito.` });
        continue;
      }
      const sniffed = sniffImageMimeType(entry.bytes);
      if (!sniffed) {
        crossErrors.push({ code: q.code, file: img.file, message: `Imagem "${img.file}": formato não reconhecido (aceitos PNG/JPEG/WebP).` });
        continue;
      }
      const expectedExtensions: Record<AllowedImageUploadMimeType, string[]> = {
        "image/png": ["png"],
        "image/jpeg": ["jpg", "jpeg"],
        "image/webp": ["webp"],
      };
      if (!expectedExtensions[sniffed].includes(extensionLower)) {
        crossErrors.push({ code: q.code, file: img.file, message: `Imagem "${img.file}": extensão não corresponde ao conteúdo real (detectado ${sniffed}).` });
        continue;
      }
      if (!isDeclaredMimeConsistent(null, sniffed)) continue; // sempre true (sem Content-Type declarado aqui) — mantido por simetria com a Sprint 18.

      crossValidatedImages.push({
        ...img,
        code: q.code,
        entry,
        mimeType: sniffed,
        sizeBytes: entry.bytes.byteLength,
        contentSha256: await sha256HexOfBytes(entry.bytes),
      });
    }
  }

  // Imagem órfã: presente em imagens/ mas nunca referenciada por nenhuma
  // questão do manifest.
  for (const path of imageEntriesByPath.keys()) {
    if (!referencedImagePaths.has(normalizeZipPathForComparison(path))) {
      crossErrors.push({ file: path, message: `Imagem "${path}" está em imagens/ mas não é referenciada por nenhuma questão no manifest (órfã).` });
    }
  }

  if (crossErrors.length > 0) {
    return {
      ok: false,
      rowCount: dataRows.length,
      validRowCount: validRows.length,
      imageCount: crossValidatedImages.length,
      errorCount: crossErrors.length,
      errors: crossErrors,
    };
  }

  // Posição determinística — seção 6 da ordem: 0-based dentro de CADA
  // grupo placement/alternativeLetter, na ordem em que aparecem no
  // manifest (nunca digitada).
  const positionCounters = new Map<string, number>();
  const rowsWithId: PackageRow[] = validRows.map((row) => ({ ...row, questionId: newId() }));

  const images: PackageImageRow[] = crossValidatedImages.map((img) => {
    const key = `${img.code}:${derivePositionKey(img.placement, img.alternativeLetter)}`;
    const position = positionCounters.get(key) ?? 0;
    positionCounters.set(key, position + 1);
    return {
      imageId: newId(),
      questionCode: img.code,
      path: img.file,
      placement: img.placement,
      alternativeLetter: img.alternativeLetter,
      altText: img.altText,
      caption: img.caption,
      position,
      mimeType: img.mimeType,
      sizeBytes: img.sizeBytes,
      contentSha256: img.contentSha256,
    };
  });

  // Nomes de padrão principal para a prévia visual (seção 11) — resolvidos
  // EM MEMÓRIA a partir do catálogo já carregado (`ctx.patterns`, Sprint
  // 19.2): nenhuma consulta adicional, nem em lote — o catálogo inteiro já
  // está em memória desde `buildImportValidationContext` acima.

  const questionsSummary: PackagePreviewQuestionSummary[] = rowsWithId.map((row) => {
    const principalId = row.padroes.find((p) => p.role === "principal")?.patternId ?? null;
    return {
      code: row.code,
      enunciadoPreview: row.enunciado.slice(0, 160),
      patternName: principalId ? (ctx.patterns.getById(principalId)?.name ?? null) : null,
      images: images
        .filter((img) => img.questionCode === row.code)
        .map((img) => ({ imageId: img.imageId, path: img.path, placement: img.placement, alternativeLetter: img.alternativeLetter, altText: img.altText })),
      status: "ready",
    };
  });

  const payload: PackageBatchPayload = { sourceKind: "zip", rows: rowsWithId, images };

  // Sprint 19.1, correção 4 da ordem — calculado ANTES de qualquer coisa
  // (nesta função, antes até de existir um batchId — preview nunca chega
  // perto do R2 mesmo sem esta checagem, mas o cálculo é o MESMO que o
  // apply vai reusar, então validamos aqui primeiro para dar o erro cedo,
  // na tela de prévia, nunca só depois de Andreia tentar aplicar).
  const plannedStatements = plannedD1StatementCount(payload);
  if (plannedStatements > IMPORT_BATCH_MAX_D1_STATEMENTS) {
    return {
      ok: false,
      rowCount: dataRows.length,
      validRowCount: validRows.length,
      imageCount: images.length,
      errorCount: 1,
      errors: [
        {
          message: `Este pacote geraria ${plannedStatements} operações no banco de dados, acima do limite seguro de ${IMPORT_BATCH_MAX_D1_STATEMENTS}. Divida a importação em pacotes menores.`,
        },
      ],
    };
  }

  // Sprint 19.1, correção 3 da ordem — mesma proteção do CSV (defesa em
  // profundidade), medida em bytes UTF-8 reais do payload que será
  // REALMENTE gravado.
  const payloadJson = JSON.stringify(payload);
  if (!isPayloadWithinBatchLimit(payloadJson)) {
    return {
      ok: false,
      rowCount: dataRows.length,
      validRowCount: validRows.length,
      imageCount: images.length,
      errorCount: 1,
      errors: [{ message: PAYLOAD_TOO_LARGE_MESSAGE }],
    };
  }

  const batchId = newId();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 30).toISOString();
  const inputFingerprint = await sha256HexOfBytes(zipBytes);

  await insertImportBatch(db, {
    id: batchId,
    userId: actorUserId,
    rowCount: dataRows.length,
    validRowCount: validRows.length,
    errorCount: 0,
    payload: payloadJson,
    inputFingerprint,
    expiresAt,
  });

  await recordAuditEvent(db, newId(), "editorial_question_import_previewed", actorUserId, {
    batchId,
    sourceKind: "zip",
    rowCount: dataRows.length,
    imageCount: images.length,
    errorCount: 0,
  });

  return {
    ok: true,
    batchId,
    rowCount: dataRows.length,
    validRowCount: validRows.length,
    imageCount: images.length,
    errorCount: 0,
    questions: questionsSummary,
    expiresAt,
  };
}

/* -------------------------------- Apply -------------------------------- */

export interface PackageApplyResult {
  ok: boolean;
  notFound?: boolean;
  expired?: boolean;
  invalid?: boolean;
  fingerprintMismatch?: boolean;
  alreadyApplied?: boolean;
  conflict?: boolean;
  conflictReason?: string;
  tooManyStatements?: boolean;
  message?: string;
  appliedCount?: number;
  imageCount?: number;
  questionIds?: string[];
}

/** Sprint 19.1, correção 1 da ordem — NUNCA apaga um objeto R2 nesta
 *  chave: as chaves finais (`questions/<questionId>/<imageId>.<ext>`) são
 *  DETERMINÍSTICAS e COMPARTILHÁVEIS entre duas tentativas concorrentes do
 *  MESMO batchId (mesma prévia, mesmos questionId/imageId gerados no
 *  preview). Uma tentativa que falha (upload parcial, falha de D1, ou
 *  perda de corrida) NUNCA consegue provar que é a ÚNICA dona daquela
 *  chave — outra tentativa concorrente pode ter subido o MESMO objeto e
 *  estar prestes a (ou já ter) confirmado no D1. Apagar aqui arriscaria
 *  deixar o D1 do VENCEDOR apontando para um objeto inexistente — a
 *  violação mais grave que este pipeline pode cometer (seção 12 da ordem
 *  original: "nunca D1 apontando conscientemente para objeto inexistente").
 *
 *  A correção deliberada: preferir um eventual objeto R2 órfão (estado
 *  RECUPERÁVEL — um retry legítimo do mesmo lote reconhece a key
 *  determinística já existente e a REUTILIZA, comparando
 *  contentSha256/MIME/tamanho, ver o laço de upload abaixo) a qualquer
 *  chance de corrupção D1→R2. Só registra tecnicamente (nunca conteúdo
 *  sensível) para eventual limpeza manual futura — nunca apaga. */
function logPotentialOrphans(context: string, keys: string[], error: unknown): void {
  if (keys.length === 0) return;
  console.error(`questionPackageImportService: ${context} — as chaves abaixo desta tentativa NÃO foram apagadas (podem ficar órfãs, recuperáveis por retry)`, {
    keys,
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function applyPackage(db: D1Database, bucket: R2Bucket, actorUserId: string, batchId: string, zipBytes: Uint8Array): Promise<PackageApplyResult> {
  const batch = await findImportBatch(db, batchId);
  if (!batch || batch.user_id !== actorUserId) return { ok: false, notFound: true };

  let payload: PackageBatchPayload;
  try {
    const parsedPayload = JSON.parse(batch.payload) as unknown;
    if (typeof parsedPayload !== "object" || parsedPayload === null || (parsedPayload as PackageBatchPayload).sourceKind !== "zip") {
      return { ok: false, invalid: true };
    }
    payload = parsedPayload as PackageBatchPayload;
  } catch {
    return { ok: false, invalid: true };
  }

  if (batch.status === "applied") {
    const items = await listImportItems(db, batchId);
    return {
      ok: true,
      alreadyApplied: true,
      questionIds: items.map((i) => i.question_id).filter((id): id is string => id !== null),
    };
  }
  if (batch.status !== "previewed") return { ok: false, invalid: true };
  if (new Date(batch.expires_at).getTime() < Date.now()) return { ok: false, expired: true };

  // Seção 10 da ordem — o servidor NUNCA confia num ZIP "reenviado" sem
  // provar que é byte-a-byte o MESMO que gerou este batchId.
  const resentFingerprint = await sha256HexOfBytes(zipBytes);
  if (resentFingerprint !== batch.input_fingerprint) return { ok: false, fingerprintMismatch: true };

  // -------- Revalidação completa contra o estado ATUAL do banco (seção 12) --------
  // Sprint 19.2, seção 8 da ordem — três consultas em lote (chunked: todos
  // os codes, todos os fingerprints, todos os patternIds do lote INTEIRO),
  // nunca uma consulta por linha. A ordem de checagem por linha (código →
  // fingerprint → padrões, na ordem de `payload.rows`) é preservada — só
  // contra Sets já carregados, não contra o D1 a cada iteração.
  const revalidation = await loadApplyRevalidationSets(db, {
    codes: payload.rows.map((r) => r.code),
    fingerprints: payload.rows.map((r) => r.fingerprint),
    patternIds: payload.rows.flatMap((r) => r.padroes.map((p) => p.patternId)),
  });
  for (const row of payload.rows) {
    if (revalidation.existingCodes.has(row.code)) return { ok: false, conflict: true, conflictReason: `Código "${row.code}" já existe.` };
    if (revalidation.existingFingerprints.has(row.fingerprint)) {
      return { ok: false, conflict: true, conflictReason: `Enunciado de "${row.code}" já existe (fingerprint).` };
    }
    const patternIds = row.padroes.map((p) => p.patternId);
    if (patternIds.some((id) => !revalidation.existingPatternIds.has(id))) {
      return { ok: false, conflict: true, conflictReason: `Um ou mais padrões de "${row.code}" não existem mais.` };
    }
  }

  // Re-extrai o ZIP reenviado (nunca persistimos bytes de imagem entre
  // preview e apply — seção 9) — o fingerprint do arquivo INTEIRO já
  // provado idêntico acima implica que todo byte interno também é
  // idêntico, mas recomputamos o hash de CADA imagem mesmo assim (é
  // essencialmente grátis já que os bytes precisam ser extraídos de
  // qualquer forma para o upload) como segunda camada de garantia — nunca
  // confiando só na igualdade do hash externo.
  const zipResult = await readZipSafely(zipBytes, {
    maxCompressedBytes: PACKAGE_MAX_ZIP_COMPRESSED_BYTES,
    maxTotalUncompressedBytes: PACKAGE_MAX_TOTAL_UNCOMPRESSED_BYTES,
    maxEntries: PACKAGE_MAX_ENTRIES,
    maxSingleFileBytes: PACKAGE_MAX_SINGLE_FILE_BYTES,
  });
  if (!zipResult.ok) return { ok: false, invalid: true };
  const entryByPath = new Map(zipResult.entries!.map((e) => [e.path, e] as const));

  for (const image of payload.images) {
    const entry = entryByPath.get(image.path);
    if (!entry) return { ok: false, invalid: true };
    const recomputedHash = await sha256HexOfBytes(entry.bytes);
    if (recomputedHash !== image.contentSha256 || entry.bytes.byteLength !== image.sizeBytes) {
      return { ok: false, invalid: true };
    }
  }

  // Sprint 19.1, correção 4 da ordem — recalculado aqui (nunca confiamos só
  // no preview, que pode ter sido gerado antes desta correção existir, ou
  // cujo resultado nunca é a fonte de verdade do que será REALMENTE
  // enviado) e verificado ANTES de qualquer upload R2 — se o pacote
  // ultrapassa o teto seguro, nenhum objeto sobe para o R2.
  const plannedStatements = plannedD1StatementCount(payload);
  if (plannedStatements > IMPORT_BATCH_MAX_D1_STATEMENTS) {
    return {
      ok: false,
      tooManyStatements: true,
      message: `Este pacote geraria ${plannedStatements} operações no banco de dados, acima do limite seguro de ${IMPORT_BATCH_MAX_D1_STATEMENTS}. Divida a importação em pacotes menores.`,
    };
  }

  // -------- Upload R2 (seção 12: só depois de TUDO revalidado) --------
  const uploadedThisAttempt: string[] = [];
  const imageKeyById = new Map<string, string>();

  try {
    for (const image of payload.images) {
      const row = payload.rows.find((r) => r.code === image.questionCode);
      if (!row) throw new Error(`invariante: imagem sem linha correspondente (${image.questionCode})`);
      const realKey = buildR2AssetKey(row.questionId, image.imageId, image.mimeType);
      imageKeyById.set(image.imageId, realKey);

      const entry = entryByPath.get(image.path)!;

      // Seção 13 da ordem — idempotência de retry via R2: se a chave
      // determinística já existir (resto órfão de uma tentativa anterior
      // que subiu R2 mas falhou antes do D1), reutiliza SE a identidade
      // bater (hash+MIME+tamanho); se divergir, conflito fail-closed —
      // nunca sobrescreve silenciosamente.
      const existing = await bucket.head(realKey);
      if (existing) {
        const identical =
          existing.customMetadata?.contentSha256 === image.contentSha256 &&
          existing.httpMetadata?.contentType === image.mimeType &&
          existing.size === image.sizeBytes;
        if (!identical) {
          return { ok: false, conflict: true, conflictReason: `Objeto R2 "${realKey}" já existe com conteúdo diferente.` };
        }
        // Idêntico — reutiliza sem novo put(), e NUNCA entra em
        // `uploadedThisAttempt` (não foi esta tentativa que o criou).
        continue;
      }

      await bucket.put(realKey, entry.bytes, {
        httpMetadata: { contentType: image.mimeType },
        customMetadata: { contentSha256: image.contentSha256 },
      });
      uploadedThisAttempt.push(realKey);
    }
  } catch (error) {
    // Correção 1 — NUNCA apaga: ver logPotentialOrphans. Um upload
    // parcialmente concluído (algumas imagens já em R2, outras não) fica
    // como está; um retry do mesmo lote reconhece as chaves já presentes
    // (idênticas, por hash) e só sobe as que faltam.
    logPotentialOrphans("falha durante upload de imagens ao R2", uploadedThisAttempt, error);
    throw error;
  }

  // -------- D1 atômico (seção 12: só depois de TODOS os uploads R2 corretos) --------
  const statements: D1PreparedStatement[] = [buildMarkBatchAppliedStatement(db, batchId)];
  for (const row of payload.rows) {
    statements.push(
      buildInsertQuestionStatement(db, {
        id: row.questionId,
        code: row.code,
        enunciado: row.enunciado,
        resolucaoComentada: row.resolucaoComentada,
        conteudo: row.conteudo,
        subconteudo: row.subconteudo,
        habilidade: row.habilidade,
        competencia: row.competencia,
        dificuldade: row.dificuldade,
        origem: row.origem,
        prova: row.prova,
        ano: row.ano,
        tempoEstimadoSegundos: row.tempoEstimadoSegundos,
        tipoCalculo: row.tipoCalculo as never,
        necessitaCalculadora: row.necessitaCalculadora ? 1 : 0,
        autorId: actorUserId,
        titularDireitos: row.titularDireitos,
        baseLicenca: row.baseLicenca,
        textoAtribuicao: row.textoAtribuicao,
        fingerprint: row.fingerprint,
        isLocalFixture: 0,
      })
    );
    statements.push(buildUpsertDnaStatement(db, row.questionId, row.dna));
    row.alternativas.forEach((alt, index) => statements.push(buildInsertAlternativeStatement(db, row.questionId, newId(), alt, index)));
    row.padroes.forEach((link) => statements.push(buildInsertPatternLinkStatement(db, row.questionId, newId(), link)));
    row.tags.forEach((tag, index) => statements.push(buildInsertTagStatement(db, row.questionId, newId(), tag, index)));
    statements.push(
      buildConditionalHistoryStatement(db, {
        id: newId(),
        questionId: row.questionId,
        userId: actorUserId,
        action: "import_applied",
        fromStatus: null,
        toStatus: "draft",
        guardVersion: 1,
        versionAfter: 1,
        metadata: { batchId },
      })
    );
    statements.push(buildInsertImportItemStatement(db, { id: newId(), batchId, rowNumber: row.rowNumber, code: row.code, questionId: row.questionId }));
  }
  for (const image of payload.images) {
    const row = payload.rows.find((r) => r.code === image.questionCode)!;
    const key = imageKeyById.get(image.imageId)!;
    statements.push(
      buildStandaloneInsertImageStatement(db, {
        id: image.imageId,
        questionId: row.questionId,
        assetRef: key,
        altText: image.altText,
        caption: image.caption,
        position: image.position,
        placement: image.placement,
        alternativeLetter: image.alternativeLetter,
        storageKind: "r2",
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        contentSha256: image.contentSha256,
      })
    );
  }

  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    // Correção 1 — NUNCA apaga aqui. Uma causa comum desta exceção é
    // justamente OUTRA tentativa concorrente do MESMO batchId ter vencido
    // a corrida e já ter inserido as MESMAS questions(id=...) (violação de
    // PRIMARY KEY) — nesse caso, as chaves R2 desta tentativa são
    // EXATAMENTE as mesmas que o vencedor está usando; apagá-las corromperia
    // o apply que teve sucesso. Deixar como está é sempre seguro: se
    // ninguém mais venceu, um retry reconhece e reaproveita; se alguém
    // venceu, os objetos já são dele também (mesma chave determinística).
    logPotentialOrphans("falha ao aplicar o lote no D1", uploadedThisAttempt, error);

    // Sprint 19.1, correção 1 da ordem (teste adversarial A/B) — o erro que
    // chegou aqui é, na prática, quase sempre uma violação de PRIMARY
    // KEY/UNIQUE nas linhas determinísticas (mesmos questionId/imageId):
    // outra tentativa concorrente do MESMO batchId venceu a corrida e já
    // commitou entre a checagem de status feita no início desta chamada e
    // agora. Antes de propagar como falha genérica (que o chamador não
    // saberia distinguir de uma falha real), confere explicitamente esse
    // caso: se o lote já está 'applied' agora, devolve o MESMO resultado
    // de sucesso que um retry legítimo receberia — nunca uma exceção solta
    // para quem só perdeu uma corrida legítima contra outra tentativa
    // válida do mesmo lote.
    const maybeApplied = await findImportBatch(db, batchId);
    if (maybeApplied?.status === "applied") {
      const items = await listImportItems(db, batchId);
      return { ok: true, alreadyApplied: true, questionIds: items.map((i) => i.question_id).filter((id): id is string => id !== null) };
    }
    throw error;
  }

  const [markResult] = results;
  if (markResult.meta.changes !== 1) {
    // Corrida real: outra requisição aplicou o mesmo lote entre a checagem
    // e agora. NUNCA limpa os objetos R2 desta tentativa (correção 1) — se
    // a outra tentativa é a mesma prévia (mesmo batchId), as chaves
    // determinísticas coincidem e são exatamente as que ELA está usando;
    // apagá-las agora corromperia o apply vencedor.
    const wasApplied = await findImportBatch(db, batchId);
    if (wasApplied?.status === "applied") {
      const items = await listImportItems(db, batchId);
      return { ok: true, alreadyApplied: true, questionIds: items.map((i) => i.question_id).filter((id): id is string => id !== null) };
    }
    return { ok: false, conflict: true };
  }

  await recordAuditEvent(db, newId(), "editorial_question_import_applied", actorUserId, {
    batchId,
    sourceKind: "zip",
    appliedCount: payload.rows.length,
    imageCount: payload.images.length,
  });

  return { ok: true, appliedCount: payload.rows.length, imageCount: payload.images.length, questionIds: payload.rows.map((r) => r.questionId) };
}

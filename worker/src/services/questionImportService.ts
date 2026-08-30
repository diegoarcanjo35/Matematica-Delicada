/* Serviço de importação CSV do Banco de Questões — Sprint 7 v1.0, seção 8
   da ordem.

   Preview NUNCA cria questão — só um registro técnico leve de lote/prévia
   (question_import_batches), com expiração. Apply só a partir de um preview
   válido e não expirado, cria TODAS as questões como `draft` num único
   db.batch() (falha em qualquer statement reverte o lote inteiro — nunca
   parcial). Undo só admin, só lote aplicado, só se todas as questões do
   lote continuarem `draft` (seção 8.3: "sem uso/publicação" — como esta
   sprint não tem player/tentativas, "uso" se reduz a "saiu do status
   draft"), remove atomicamente questão+dependentes, nunca apaga padrão. */

import { parseCsv, serializeCsvReport } from "../lib/csv";
import { sha256Hex } from "../lib/crypto";
import {
  QUESTION_ALTERNATIVE_LETTERS,
  QUESTION_CALCULATION_TYPES,
  QUESTION_DIFFICULTIES,
  QUESTION_ORIGINS,
  QUESTION_TEXT_MAX_LENGTH,
  type AlternativeInput,
  type QuestionDifficulty,
  type QuestionDnaInput,
  type QuestionOrigin,
  type QuestionPatternInput,
} from "../lib/questionsValidation";
import { computeQuestionFingerprint } from "../lib/fingerprint";
import { recordAuditEvent } from "../repositories/auditRepository";
import {
  buildDeleteQuestionChildrenForUndoStatements,
  buildDeleteQuestionForUndoStatement,
  buildDetachImportItemsStatement,
  buildInsertImportItemStatement,
  buildMarkBatchAppliedStatement,
  buildMarkBatchUndoneStatement,
  findImportBatch,
  insertImportBatch,
  listImportItems,
} from "../repositories/questionImportRepository";
import {
  buildConditionalHistoryStatement,
  buildInsertAlternativeStatement,
  buildInsertImageStatement,
  buildInsertPatternLinkStatement,
  buildInsertQuestionStatement,
  buildInsertTagStatement,
  buildUpsertDnaStatement,
  findQuestionByCode,
  findQuestionsByFingerprint,
} from "../repositories/questionRepository";

function newId(): string {
  return crypto.randomUUID();
}

export const IMPORT_MAX_FILE_BYTES = 300 * 1024; // 300KB
export const IMPORT_MAX_ROWS = 500;
export const IMPORT_PREVIEW_TTL_MS = 1000 * 60 * 30; // 30min

export const IMPORT_CSV_HEADERS = [
  "codigo",
  "enunciado",
  "resolucao_comentada",
  "conteudo",
  "subconteudo",
  "habilidade",
  "competencia",
  "dificuldade",
  "origem",
  "prova",
  "ano",
  "tempo_estimado_segundos",
  "tipo_calculo",
  "necessita_calculadora",
  "alt_a",
  "alt_b",
  "alt_c",
  "alt_d",
  "alt_e",
  "correta",
  "pista",
  "estrategia",
  "pegadinha",
  "conteudo_apoio",
  "resolucao_dna",
  "atalho",
  "aprendizado_erro",
  "padrao_principal_code",
  "padroes_secundarios_codes",
  "tags",
  "titular_direitos",
  "base_licenca",
  "texto_atribuicao",
  "imagem_ref",
  "imagem_alt",
] as const;

export interface ImportRowError {
  row: number;
  field: string;
  message: string;
  /** Valor bruto da célula que causou o erro, quando aplicável — usado só
   *  para o relatório de erros exibido/exportado (nunca gravado em
   *  question_import_batches.payload, que só guarda linhas VÁLIDAS). Sprint
   *  7 v1.1, Correção B: ao exportar como CSV, este valor passa por
   *  neutralização de fórmula igual a qualquer outra célula exportada. */
  value?: string;
}

export interface ParsedImportRow {
  rowNumber: number;
  code: string;
  enunciado: string;
  resolucaoComentada: string;
  conteudo: string;
  subconteudo: string;
  habilidade: string;
  competencia: string;
  dificuldade: QuestionDifficulty;
  origem: QuestionOrigin;
  prova: string | null;
  ano: number | null;
  tempoEstimadoSegundos: number | null;
  tipoCalculo: string;
  necessitaCalculadora: boolean;
  alternativas: AlternativeInput[];
  dna: QuestionDnaInput;
  padroes: QuestionPatternInput[];
  tags: string[];
  titularDireitos: string | null;
  baseLicenca: string | null;
  textoAtribuicao: string | null;
  imagemRef: string | null;
  imagemAlt: string | null;
  fingerprint: string;
}

function cell(row: string[], headerIndex: Record<string, number>, name: string): string {
  const idx = headerIndex[name];
  return idx === undefined ? "" : (row[idx] ?? "").trim();
}

function splitMultivalue(value: string): string[] {
  return value
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** Sprint 7 v1.1, Correção B — a importação NUNCA rejeita uma linha por
 *  causa do primeiro caractere de um campo pedagógico: `-5`, `+3`,
 *  `= 2x + 4` e `@ representa uma variável` são conteúdo matemático
 *  legítimo. Cada célula é tratada como texto puro; a única proteção
 *  contra fórmula executável vive do lado de EXPORTAÇÃO (ver
 *  worker/src/lib/csv.ts) — a importação em si nunca "executa" nada, então
 *  não há risco de injeção a rejeitar aqui. Validação continua sendo 100%
 *  SEMÂNTICA por campo (código/ano/dificuldade/origem/status abaixo). */
async function parseAndValidateRow(
  db: D1Database,
  row: string[],
  headerIndex: Record<string, number>,
  rowNumber: number,
  seenCodesInFile: Map<string, number>,
  seenFingerprintsInFile: Map<string, number>
): Promise<{ parsed: ParsedImportRow | null; errors: ImportRowError[] }> {
  const errors: ImportRowError[] = [];

  const code = cell(row, headerIndex, "codigo");
  if (!code) errors.push({ row: rowNumber, field: "codigo", message: "Código é obrigatório." });
  if (code.length > 40) errors.push({ row: rowNumber, field: "codigo", message: "Código excede o tamanho máximo." });

  const enunciado = cell(row, headerIndex, "enunciado");
  if (!enunciado) errors.push({ row: rowNumber, field: "enunciado", message: "Enunciado é obrigatório." });
  if (enunciado.length > QUESTION_TEXT_MAX_LENGTH) errors.push({ row: rowNumber, field: "enunciado", message: "Enunciado excede o tamanho máximo." });

  const dificuldade = cell(row, headerIndex, "dificuldade");
  if (!(QUESTION_DIFFICULTIES as readonly string[]).includes(dificuldade)) {
    errors.push({ row: rowNumber, field: "dificuldade", message: "Dificuldade inválida." });
  }

  const origem = cell(row, headerIndex, "origem");
  if (!(QUESTION_ORIGINS as readonly string[]).includes(origem)) {
    errors.push({ row: rowNumber, field: "origem", message: "Origem/tipo inválido." });
  }

  const tipoCalculoRaw = cell(row, headerIndex, "tipo_calculo") || "misto";
  if (!(QUESTION_CALCULATION_TYPES as readonly string[]).includes(tipoCalculoRaw)) {
    errors.push({ row: rowNumber, field: "tipo_calculo", message: "Tipo de cálculo inválido." });
  }

  const anoRaw = cell(row, headerIndex, "ano");
  let ano: number | null = null;
  if (anoRaw) {
    ano = Number(anoRaw);
    if (!Number.isInteger(ano) || ano < 1990 || ano > 2100) {
      errors.push({ row: rowNumber, field: "ano", message: "Ano inválido." });
      ano = null;
    }
  }

  const tempoRaw = cell(row, headerIndex, "tempo_estimado_segundos");
  let tempoEstimadoSegundos: number | null = null;
  if (tempoRaw) {
    tempoEstimadoSegundos = Number(tempoRaw);
    if (!Number.isInteger(tempoEstimadoSegundos) || tempoEstimadoSegundos <= 0) {
      errors.push({ row: rowNumber, field: "tempo_estimado_segundos", message: "Tempo estimado inválido." });
      tempoEstimadoSegundos = null;
    }
  }

  const necessitaCalculadoraRaw = cell(row, headerIndex, "necessita_calculadora").toLowerCase();
  const necessitaCalculadora = necessitaCalculadoraRaw === "sim" || necessitaCalculadoraRaw === "true" || necessitaCalculadoraRaw === "1";
  if (necessitaCalculadoraRaw && !["sim", "nao", "não", "true", "false", "0", "1"].includes(necessitaCalculadoraRaw)) {
    errors.push({ row: rowNumber, field: "necessita_calculadora", message: "Valor inválido (use sim/nao)." });
  }

  const correta = cell(row, headerIndex, "correta").toUpperCase();
  const alternativas: AlternativeInput[] = QUESTION_ALTERNATIVE_LETTERS.map((letter) => {
    const text = cell(row, headerIndex, `alt_${letter.toLowerCase()}`);
    if (!text) errors.push({ row: rowNumber, field: `alt_${letter.toLowerCase()}`, message: `Alternativa ${letter} não pode ser vazia.` });
    return { letter, text, isCorrect: letter === correta, distractorExplanation: null };
  });
  if (!(QUESTION_ALTERNATIVE_LETTERS as readonly string[]).includes(correta)) {
    errors.push({ row: rowNumber, field: "correta", message: "Letra da alternativa correta inválida." });
  }

  const padraoPrincipalCode = cell(row, headerIndex, "padrao_principal_code");
  if (!padraoPrincipalCode) errors.push({ row: rowNumber, field: "padrao_principal_code", message: "Padrão principal é obrigatório." });

  const patternRows = await db
    .prepare("SELECT id, code FROM patterns WHERE code = ?")
    .bind(padraoPrincipalCode)
    .first<{ id: string; code: string }>();
  const padroes: QuestionPatternInput[] = [];
  if (padraoPrincipalCode && !patternRows) {
    errors.push({ row: rowNumber, field: "padrao_principal_code", message: `Padrão "${padraoPrincipalCode}" não existe (importação nunca cria padrão).` });
  } else if (patternRows) {
    padroes.push({ patternId: patternRows.id, role: "principal" });
  }

  const secondaryCodes = splitMultivalue(cell(row, headerIndex, "padroes_secundarios_codes"));
  for (const secCode of secondaryCodes) {
    const secRow = await db.prepare("SELECT id FROM patterns WHERE code = ?").bind(secCode).first<{ id: string }>();
    if (!secRow) {
      errors.push({ row: rowNumber, field: "padroes_secundarios_codes", message: `Padrão secundário "${secCode}" não existe.` });
      continue;
    }
    if (secRow.id === patternRows?.id) {
      errors.push({ row: rowNumber, field: "padroes_secundarios_codes", message: `O padrão "${secCode}" não pode ser principal e secundário ao mesmo tempo.` });
      continue;
    }
    if (padroes.some((p) => p.patternId === secRow.id)) continue;
    padroes.push({ patternId: secRow.id, role: "secundario" });
  }

  const tags = splitMultivalue(cell(row, headerIndex, "tags"));

  if (code) {
    if (seenCodesInFile.has(code)) {
      errors.push({ row: rowNumber, field: "codigo", message: `Código duplicado no arquivo (também na linha ${seenCodesInFile.get(code)}).` });
    } else {
      seenCodesInFile.set(code, rowNumber);
    }
    const existing = await findQuestionByCode(db, code);
    if (existing) errors.push({ row: rowNumber, field: "codigo", message: "Já existe uma questão com este código no banco." });
  }

  // Correção C (Sprint 7 v1.1) — MESMA função de
  // worker/src/lib/fingerprint.ts usada pela criação unitária, com as
  // MESMAS alternativas (texto + indicação de correta) já parseadas acima —
  // garante que a mesma questão via formulário ou via CSV produz o mesmo
  // fingerprint.
  const fingerprint = enunciado ? await computeQuestionFingerprint(enunciado, alternativas) : "";
  if (fingerprint) {
    if (seenFingerprintsInFile.has(fingerprint)) {
      errors.push({ row: rowNumber, field: "enunciado", message: `Enunciado equivalente a outra linha do arquivo (linha ${seenFingerprintsInFile.get(fingerprint)}).` });
    } else {
      seenFingerprintsInFile.set(fingerprint, rowNumber);
    }
    const dbDuplicates = await findQuestionsByFingerprint(db, fingerprint);
    if (dbDuplicates.length > 0) errors.push({ row: rowNumber, field: "enunciado", message: "Enunciado equivalente a uma questão já existente no banco (fingerprint duplicada)." });
  }

  const imagemRef = cell(row, headerIndex, "imagem_ref") || null;
  const imagemAlt = cell(row, headerIndex, "imagem_alt") || null;
  if (imagemRef && !imagemAlt) {
    errors.push({ row: rowNumber, field: "imagem_alt", message: "Texto alternativo obrigatório quando há referência de imagem." });
  }

  if (errors.length > 0) {
    // Anexa o valor bruto da célula responsável, quando o nome do campo
    // corresponde a um cabeçalho real — só para exibição/exportação do
    // relatório de erros (nunca persistido em question_import_batches).
    const withValues = errors.map((e) => ({
      ...e,
      value: (IMPORT_CSV_HEADERS as readonly string[]).includes(e.field) ? cell(row, headerIndex, e.field) : undefined,
    }));
    return { parsed: null, errors: withValues };
  }

  return {
    parsed: {
      rowNumber,
      code,
      enunciado,
      resolucaoComentada: cell(row, headerIndex, "resolucao_comentada"),
      conteudo: cell(row, headerIndex, "conteudo"),
      subconteudo: cell(row, headerIndex, "subconteudo"),
      habilidade: cell(row, headerIndex, "habilidade"),
      competencia: cell(row, headerIndex, "competencia"),
      dificuldade: dificuldade as QuestionDifficulty,
      origem: origem as QuestionOrigin,
      prova: cell(row, headerIndex, "prova") || null,
      ano,
      tempoEstimadoSegundos,
      tipoCalculo: tipoCalculoRaw,
      necessitaCalculadora,
      alternativas,
      dna: {
        pista: cell(row, headerIndex, "pista"),
        estrategia: cell(row, headerIndex, "estrategia"),
        pegadinha: cell(row, headerIndex, "pegadinha"),
        conteudoApoio: cell(row, headerIndex, "conteudo_apoio"),
        resolucao: cell(row, headerIndex, "resolucao_dna"),
        atalho: cell(row, headerIndex, "atalho") || null,
        aprendizadoErro: cell(row, headerIndex, "aprendizado_erro"),
      },
      padroes,
      tags,
      titularDireitos: cell(row, headerIndex, "titular_direitos") || null,
      baseLicenca: cell(row, headerIndex, "base_licenca") || null,
      textoAtribuicao: cell(row, headerIndex, "texto_atribuicao") || null,
      imagemRef,
      imagemAlt,
      fingerprint,
    },
    errors: [],
  };
}

export interface PreviewResult {
  ok: boolean;
  batchId?: string;
  rowCount?: number;
  validRowCount?: number;
  errorCount?: number;
  errors?: ImportRowError[];
  /** CSV pronto para download com o mesmo conteúdo de `errors`, mas com
   *  neutralização de fórmula aplicada (Correção B) — `null` quando não há
   *  erro nenhum. */
  errorsReportCsv?: string | null;
  expiresAt?: string;
  reason?: "empty" | "too_large" | "bad_header" | "malformed";
  message?: string;
}

export async function previewImport(db: D1Database, actorUserId: string, fileBytes: Uint8Array): Promise<PreviewResult> {
  if (fileBytes.byteLength === 0) return { ok: false, reason: "empty", message: "Arquivo vazio." };
  if (fileBytes.byteLength > IMPORT_MAX_FILE_BYTES) {
    return { ok: false, reason: "too_large", message: `Arquivo excede o limite de ${IMPORT_MAX_FILE_BYTES} bytes.` };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fileBytes);
  } catch {
    return { ok: false, reason: "malformed", message: "Arquivo não está em UTF-8 válido." };
  }

  const parseResult = parseCsv(text, IMPORT_MAX_ROWS);
  if (!parseResult.ok) return { ok: false, reason: "malformed", message: parseResult.error };

  const [headerRow, ...dataRows] = parseResult.rows!;
  const headerIndex: Record<string, number> = {};
  headerRow.forEach((h, i) => (headerIndex[h.trim()] = i));

  const missingHeaders = IMPORT_CSV_HEADERS.filter((h) => !(h in headerIndex));
  if (missingHeaders.length > 0) {
    return { ok: false, reason: "bad_header", message: `Cabeçalho ausente: ${missingHeaders.join(", ")}.` };
  }

  if (dataRows.length === 0) return { ok: false, reason: "empty", message: "Arquivo sem linhas de dados." };

  const errors: ImportRowError[] = [];
  const validRows: ParsedImportRow[] = [];
  const seenCodesInFile = new Map<string, number>();
  const seenFingerprintsInFile = new Map<string, number>();

  for (let i = 0; i < dataRows.length; i++) {
    const rowNumber = i + 2; // linha 1 é o cabeçalho
    const columnCountMismatch = dataRows[i].length !== headerRow.length;
    if (columnCountMismatch) {
      errors.push({ row: rowNumber, field: "_linha", message: `Número de colunas (${dataRows[i].length}) difere do cabeçalho (${headerRow.length}).` });
      continue;
    }
    const { parsed, errors: rowErrors } = await parseAndValidateRow(db, dataRows[i], headerIndex, rowNumber, seenCodesInFile, seenFingerprintsInFile);
    if (rowErrors.length > 0) {
      // Nunca ecoa o conteúdo completo da LINHA — só campo+mensagem+valor da
      // célula responsável (nunca as outras ~30 colunas da linha).
      errors.push(...rowErrors);
    } else if (parsed) {
      validRows.push(parsed);
    }
  }

  const batchId = newId();
  const expiresAt = new Date(Date.now() + IMPORT_PREVIEW_TTL_MS).toISOString();
  const inputFingerprint = await sha256Hex(text);

  await insertImportBatch(db, {
    id: batchId,
    userId: actorUserId,
    rowCount: dataRows.length,
    validRowCount: validRows.length,
    errorCount: errors.length,
    // Só persiste linhas válidas — payload nunca contém o CSV bruto nem
    // linhas rejeitadas (nunca conteúdo de log completo — seção 8.3).
    payload: JSON.stringify(errors.length === 0 ? validRows : []),
    inputFingerprint,
    expiresAt,
  });

  await recordAuditEvent(db, newId(), "editorial_question_import_previewed", actorUserId, {
    batchId,
    rowCount: dataRows.length,
    errorCount: errors.length,
  });

  return {
    ok: true,
    batchId,
    rowCount: dataRows.length,
    validRowCount: validRows.length,
    // A resposta JSON devolve o conteúdo ORIGINAL, intacto — a UI mostra
    // isto como DADO (texto puro), nunca como HTML/fórmula executável (ver
    // src/pages/editorial/EditorialImportsPage.tsx). Neutralização de
    // fórmula só se aplica à representação CSV EXPORTADA — ver
    // `buildImportErrorReportCsv` abaixo, nunca a este JSON.
    errorCount: errors.length,
    errors,
    errorsReportCsv: errors.length > 0 ? buildImportErrorReportCsv(errors) : null,
    expiresAt,
  };
}

/** Sprint 7 v1.1, Correção B — relatório de erros como CSV EXPORTÁVEL:
 *  cabeçalho + uma linha por erro (linha do arquivo, campo, valor bruto da
 *  célula, mensagem). TODAS as células passam por
 *  `neutralizeForCsvExport` (worker/src/lib/csv.ts) — incluindo o valor
 *  original, a mensagem e o nome do campo — porque qualquer uma delas pode,
 *  em tese, começar por um caractere perigoso (ex.: um código de padrão
 *  digitado como "=PROC()"). A neutralização é só desta REPRESENTAÇÃO
 *  exportada; os dados de `errors` (JSON) e o conteúdo armazenado no banco
 *  nunca são alterados por esta função. */
export function buildImportErrorReportCsv(errors: ImportRowError[]): string {
  const headers = ["linha", "campo", "valor", "mensagem"];
  const rows = errors.map((e) => [String(e.row), e.field, e.value ?? "", e.message]);
  return serializeCsvReport(headers, rows);
}

export interface ApplyResult {
  ok: boolean;
  notFound?: boolean;
  forbidden?: boolean;
  expired?: boolean;
  invalid?: boolean;
  alreadyApplied?: boolean;
  conflict?: boolean;
  appliedCount?: number;
  questionIds?: string[];
}

export async function applyImport(db: D1Database, actorUserId: string, batchId: string): Promise<ApplyResult> {
  const batch = await findImportBatch(db, batchId);
  if (!batch || batch.user_id !== actorUserId) return { ok: false, notFound: true };

  if (batch.status === "applied") {
    const items = await listImportItems(db, batchId);
    return { ok: true, alreadyApplied: true, questionIds: items.map((i) => i.question_id).filter((id): id is string => id !== null) };
  }
  if (batch.status !== "previewed") return { ok: false, invalid: true };
  if (new Date(batch.expires_at).getTime() < Date.now()) return { ok: false, expired: true };
  if (batch.error_count > 0 || batch.valid_row_count === 0) return { ok: false, invalid: true };

  const rows = JSON.parse(batch.payload) as ParsedImportRow[];

  // Revalida duplicidade contra o estado ATUAL do banco (pode ter mudado
  // desde o preview) — se qualquer linha colidir agora, nenhuma questão do
  // lote é criada (atomicidade "tudo ou nada" também nesta revalidação).
  for (const row of rows) {
    const existingCode = await findQuestionByCode(db, row.code);
    if (existingCode) return { ok: false, conflict: true };
    const existingFingerprint = await findQuestionsByFingerprint(db, row.fingerprint);
    if (existingFingerprint.length > 0) return { ok: false, conflict: true };
  }

  const statements = [buildMarkBatchAppliedStatement(db, batchId)];
  const questionIds: string[] = [];

  for (const row of rows) {
    const questionId = newId();
    questionIds.push(questionId);
    statements.push(
      buildInsertQuestionStatement(db, {
        id: questionId,
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
    statements.push(buildUpsertDnaStatement(db, questionId, row.dna));
    row.alternativas.forEach((alt, index) => statements.push(buildInsertAlternativeStatement(db, questionId, newId(), alt, index)));
    row.padroes.forEach((link) => statements.push(buildInsertPatternLinkStatement(db, questionId, newId(), link)));
    row.tags.forEach((tag, index) => statements.push(buildInsertTagStatement(db, questionId, newId(), tag, index)));
    if (row.imagemRef && row.imagemAlt) {
      statements.push(
        buildInsertImageStatement(db, questionId, newId(), {
          assetRef: row.imagemRef,
          altText: row.imagemAlt,
          caption: null,
          position: 0,
          titularDireitos: null,
          baseLicenca: null,
        })
      );
    }
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
        metadata: { batchId },
      })
    );
    statements.push(buildInsertImportItemStatement(db, { id: newId(), batchId, rowNumber: row.rowNumber, code: row.code, questionId }));
  }

  let results;
  try {
    results = await db.batch(statements);
  } catch {
    return { ok: false, conflict: true };
  }

  const [markResult] = results;
  if (markResult.meta.changes !== 1) {
    // Outra requisição aplicou o mesmo lote entre a leitura e a escrita.
    const items = await listImportItems(db, batchId);
    return { ok: true, alreadyApplied: true, questionIds: items.map((i) => i.question_id).filter((id): id is string => id !== null) };
  }

  await recordAuditEvent(db, newId(), "editorial_question_import_applied", actorUserId, { batchId, appliedCount: rows.length });

  return { ok: true, appliedCount: rows.length, questionIds };
}

export interface UndoResult {
  ok: boolean;
  notFound?: boolean;
  forbidden?: boolean;
  alreadyUndone?: boolean;
  blocked?: boolean;
  undoneCount?: number;
}

export async function undoImport(db: D1Database, actorUserId: string, batchId: string): Promise<UndoResult> {
  const batch = await findImportBatch(db, batchId);
  if (!batch) return { ok: false, notFound: true };

  if (batch.status === "undone") return { ok: true, alreadyUndone: true, undoneCount: 0 };
  if (batch.status !== "applied") return { ok: false, blocked: true };

  const items = await listImportItems(db, batchId);
  const questionIds = items.map((i) => i.question_id).filter((id): id is string => id !== null);

  if (questionIds.length > 0) {
    const placeholders = questionIds.map(() => "?").join(", ");
    const rows = await db
      .prepare(`SELECT id, editorial_status FROM questions WHERE id IN (${placeholders})`)
      .bind(...questionIds)
      .all<{ id: string; editorial_status: string }>();
    const nonDraft = (rows.results ?? []).filter((r) => r.editorial_status !== "draft");
    if (nonDraft.length > 0) return { ok: false, blocked: true };
  }

  // ORDEM IMPORTA: cada DELETE/UPDATE guardado abaixo checa, DENTRO da
  // mesma transação, se o LOTE ainda está 'applied'/undone_at IS NULL. Se o
  // UPDATE que marca o lote como 'undone' rodasse primeiro, todo statement
  // seguinte veria o lote já 'undone' e o guard falharia silenciosamente
  // (nada seria de fato apagado) — por isso ele vai por ÚLTIMO no lote, e é
  // o único cujo meta.changes decide o resultado (idempotência real).
  const statements: D1PreparedStatement[] = [
    // Desvincula os itens do lote ANTES de apagar as questões — question_import_items.question_id
    // referencia questions(id); apagar a questão primeiro violaria a FK
    // enquanto o item ainda apontasse para ela.
    buildDetachImportItemsStatement(db, batchId),
  ];
  for (const questionId of questionIds) {
    statements.push(...buildDeleteQuestionChildrenForUndoStatements(db, questionId, batchId));
    statements.push(buildDeleteQuestionForUndoStatement(db, questionId, batchId));
  }
  statements.push(buildMarkBatchUndoneStatement(db, batchId));

  const results = await db.batch(statements);
  const markResult = results[results.length - 1];
  if (markResult.meta.changes !== 1) {
    // Corrida: outra requisição já desfez o mesmo lote.
    return { ok: true, alreadyUndone: true, undoneCount: 0 };
  }

  await recordAuditEvent(db, newId(), "editorial_question_import_undone", actorUserId, { batchId, undoneCount: questionIds.length });

  return { ok: true, undoneCount: questionIds.length };
}

export async function getImportBatchStatus(db: D1Database, batchId: string, actorUserId: string) {
  const batch = await findImportBatch(db, batchId);
  if (!batch || batch.user_id !== actorUserId) return null;
  const items = await listImportItems(db, batchId);
  return {
    id: batch.id,
    status: batch.status,
    rowCount: batch.row_count,
    validRowCount: batch.valid_row_count,
    errorCount: batch.error_count,
    createdAt: batch.created_at,
    expiresAt: batch.expires_at,
    appliedAt: batch.applied_at,
    undoneAt: batch.undone_at,
    items: items.map((i) => ({ rowNumber: i.row_number, code: i.code, questionId: i.question_id })),
  };
}

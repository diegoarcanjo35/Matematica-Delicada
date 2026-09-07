/* CSV V2 — template simplificado de importação de questões, Sprint 19,
   seção 3 da ordem. Produz o MESMO formato interno (`ParsedImportRow`, ver
   worker/src/services/questionImportService.ts) que o CSV V1 já usa — isso
   permite reaproveitar `applyImport`/`undoImport` inteiramente sem
   duplicar a máquina de atomicidade/idempotência já testada na Sprint 7.
   A única diferença é COMO cada linha é parseada/validada: menos colunas,
   `macete` mapeado para `dna.estrategia` (demais campos legados de DNA
   sempre vazios — nunca inventados), padrão principal/secundários
   resolvidos por NOME ou código (nunca só código, como no V1). */

import {
  QUESTION_ALTERNATIVE_LETTERS,
  QUESTION_DIFFICULTIES,
  QUESTION_ORIGINS,
  QUESTION_TEXT_MAX_LENGTH,
  type AlternativeInput,
  type QuestionDifficulty,
  type QuestionOrigin,
  type QuestionPatternInput,
} from "./questionsValidation";
import { computeQuestionFingerprint } from "./fingerprint";
import { findQuestionByCode, findQuestionsByFingerprint } from "../repositories/questionRepository";
import type { ImportRowError, ParsedImportRow } from "../services/questionImportService";

export const IMPORT_CSV_V2_HEADERS = [
  "codigo",
  "enunciado",
  "resolucao_comentada",
  "dificuldade",
  "origem",
  "prova",
  "ano",
  "alt_a",
  "alt_b",
  "alt_c",
  "alt_d",
  "alt_e",
  "correta",
  "macete",
  "padrao_principal",
  "padroes_secundarios",
  "tags",
  "titular_direitos",
  "base_licenca",
  "texto_atribuicao",
] as const;

/** Template V2 — SÓ o cabeçalho, sem linha de exemplo (seção 3 da ordem:
 *  "não colocar linha fictícia que não passe no próprio validador...
 *  preferência: template apenas com cabeçalho + orientação na própria
 *  UI"). Uma linha de exemplo real exigiria um `padrao_principal` que
 *  existe de verdade no banco — impossível garantir de forma estática num
 *  arquivo baixável, e um valor fictício tipo "PAD-01" falharia no próprio
 *  validador (item 9 da política de testes desta sprint). */
export function buildTemplateCsvV2(): string {
  return IMPORT_CSV_V2_HEADERS.join(",") + "\r\n";
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

interface PatternLookupRow {
  id: string;
  name: string;
}

/** Resolve um padrão por NOME (exato, depois case-insensitive/trim) ou por
 *  CÓDIGO (compatibilidade técnica, seção 3 da ordem) — sempre consultando
 *  o banco dinamicamente, nunca uma lista hardcoded. `null` quando não
 *  encontrado (o chamador decide a mensagem de erro — "importação nunca
 *  cria padrão"). */
export async function resolvePatternByNameOrCode(db: D1Database, raw: string): Promise<PatternLookupRow | null> {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const exact = await db.prepare("SELECT id, name FROM patterns WHERE name = ? OR code = ?").bind(trimmed, trimmed).first<PatternLookupRow>();
  if (exact) return exact;
  const caseInsensitive = await db
    .prepare("SELECT id, name FROM patterns WHERE name = ? COLLATE NOCASE OR code = ? COLLATE NOCASE")
    .bind(trimmed, trimmed)
    .first<PatternLookupRow>();
  return caseInsensitive ?? null;
}

/** Mesmo formato de retorno de `parseAndValidateRow` (V1) —
 *  `questionImportService.ts` trata as duas fontes de forma idêntica dali
 *  em diante. */
export async function parseAndValidateRowV2(
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

  const resolucaoComentada = cell(row, headerIndex, "resolucao_comentada");
  if (!resolucaoComentada) errors.push({ row: rowNumber, field: "resolucao_comentada", message: "Resolução comentada é obrigatória." });

  const dificuldade = cell(row, headerIndex, "dificuldade");
  if (!(QUESTION_DIFFICULTIES as readonly string[]).includes(dificuldade)) {
    errors.push({ row: rowNumber, field: "dificuldade", message: "Dificuldade inválida." });
  }

  const origem = cell(row, headerIndex, "origem");
  if (!(QUESTION_ORIGINS as readonly string[]).includes(origem)) {
    errors.push({ row: rowNumber, field: "origem", message: "Origem/tipo inválido." });
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

  const correta = cell(row, headerIndex, "correta").toUpperCase();
  const alternativas: AlternativeInput[] = QUESTION_ALTERNATIVE_LETTERS.map((letter) => {
    const text = cell(row, headerIndex, `alt_${letter.toLowerCase()}`);
    if (!text) errors.push({ row: rowNumber, field: `alt_${letter.toLowerCase()}`, message: `Alternativa ${letter} não pode ser vazia.` });
    return { letter, text, isCorrect: letter === correta, distractorExplanation: null };
  });
  if (!(QUESTION_ALTERNATIVE_LETTERS as readonly string[]).includes(correta)) {
    errors.push({ row: rowNumber, field: "correta", message: "Letra da alternativa correta inválida." });
  }

  const macete = cell(row, headerIndex, "macete");
  if (!macete) errors.push({ row: rowNumber, field: "macete", message: "Macete / Como resolver é obrigatório." });

  const padraoPrincipalRaw = cell(row, headerIndex, "padrao_principal");
  if (!padraoPrincipalRaw) errors.push({ row: rowNumber, field: "padrao_principal", message: "Padrão principal é obrigatório." });
  const principal = padraoPrincipalRaw ? await resolvePatternByNameOrCode(db, padraoPrincipalRaw) : null;
  const padroes: QuestionPatternInput[] = [];
  if (padraoPrincipalRaw && !principal) {
    errors.push({ row: rowNumber, field: "padrao_principal", message: `Padrão "${padraoPrincipalRaw}" não existe (importação nunca cria padrão).` });
  } else if (principal) {
    padroes.push({ patternId: principal.id, role: "principal" });
  }

  const secondaryRaw = splitMultivalue(cell(row, headerIndex, "padroes_secundarios"));
  for (const raw of secondaryRaw) {
    const secondary = await resolvePatternByNameOrCode(db, raw);
    if (!secondary) {
      errors.push({ row: rowNumber, field: "padroes_secundarios", message: `Padrão secundário "${raw}" não existe.` });
      continue;
    }
    if (secondary.id === principal?.id) {
      errors.push({ row: rowNumber, field: "padroes_secundarios", message: `O padrão "${raw}" não pode ser principal e secundário ao mesmo tempo.` });
      continue;
    }
    if (padroes.some((p) => p.patternId === secondary.id)) continue;
    padroes.push({ patternId: secondary.id, role: "secundario" });
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

  if (errors.length > 0) {
    const withValues = errors.map((e) => ({
      ...e,
      value: (IMPORT_CSV_V2_HEADERS as readonly string[]).includes(e.field) ? cell(row, headerIndex, e.field) : undefined,
    }));
    return { parsed: null, errors: withValues };
  }

  return {
    parsed: {
      rowNumber,
      code,
      enunciado,
      resolucaoComentada,
      // Sprint 18/19 — campos "avançados" ausentes do template V2 nunca são
      // inventados: strings vazias, servidor nunca supõe conteúdo.
      conteudo: "",
      subconteudo: "",
      habilidade: "",
      competencia: "",
      dificuldade: dificuldade as QuestionDifficulty,
      origem: origem as QuestionOrigin,
      prova: cell(row, headerIndex, "prova") || null,
      ano,
      tempoEstimadoSegundos: null,
      tipoCalculo: "misto",
      necessitaCalculadora: false,
      alternativas,
      dna: {
        pista: "",
        estrategia: macete,
        pegadinha: "",
        conteudoApoio: "",
        resolucao: "",
        atalho: null,
        aprendizadoErro: "",
      },
      padroes,
      tags,
      titularDireitos: cell(row, headerIndex, "titular_direitos") || null,
      baseLicenca: cell(row, headerIndex, "base_licenca") || null,
      textoAtribuicao: cell(row, headerIndex, "texto_atribuicao") || null,
      imagemRef: null,
      imagemAlt: null,
      fingerprint,
    },
    errors: [],
  };
}

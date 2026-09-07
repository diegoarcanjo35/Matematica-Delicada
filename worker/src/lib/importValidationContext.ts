import { QUESTION_ALTERNATIVE_LETTERS, type AlternativeInput } from "./questionsValidation";
import { computeQuestionFingerprint } from "./fingerprint";

/* Sprint 19.2 da ordem — elimina o N+1 de consultas D1 na importação
   (CSV V1, CSV V2, Pacote ZIP). Antes desta correção, o parser de CADA
   LINHA fazia, ele mesmo, uma ou mais consultas D1 (resolução de padrão
   principal, resolução de padrões secundários, existência de código,
   existência de fingerprint) — um preview de 100 questões podia gerar
   várias centenas de round-trips D1, arriscando o teto de "Queries per
   Worker invocation" da Cloudflare (50 no plano Free, 1000 no Paid;
   https://developers.cloudflare.com/d1/platform/limits/ — consultado nesta
   correção). Este módulo separa:

     1) uma leitura ÚNICA e completa do catálogo de padrões (`patterns`
        nunca passa de algumas dezenas/centenas de linhas — cabe inteiro em
        memória, resolvido ali por nome/código sem nenhuma consulta por
        linha);
     2) consultas EM LOTE (chunked, respeitando o teto de 100 parâmetros
        vinculados por statement do D1) para "quais destes códigos/
        fingerprints/IDs de padrão já existem no banco".

   O parser de cada linha (worker/src/lib/questionImportV2.ts,
   worker/src/services/questionImportService.ts) passa a consultar esse
   contexto EM MEMÓRIA (síncrono) em vez de fazer `await db.prepare(...)`
   por linha — zero round-trips D1 dentro do laço por linha. */

export const D1_MAX_BOUND_PARAMS_PER_QUERY = 100;

/** Margem de segurança abaixo do teto real de 100 parâmetros vinculados
 *  por statement do D1 — nunca encostar exatamente no limite documentado. */
export const IN_CLAUSE_CHUNK_SIZE = 90;

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk: size deve ser positivo.");
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Remove duplicatas e valores vazios — nunca gera um chunk/consulta para
 *  uma célula em branco (código/fingerprint ausente não é "existente"). */
function distinctNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => v.length > 0)));
}

function cell(row: string[], headerIndex: Record<string, number>, name: string): string {
  const idx = headerIndex[name];
  return idx === undefined ? "" : (row[idx] ?? "").trim();
}

/** Extrai só os campos necessários para calcular código+fingerprint de uma
 *  linha — código, enunciado e as 5 alternativas (texto + qual é a
 *  correta). Estes nomes de coluna são IDÊNTICOS entre o template CSV V1 e
 *  V2 (`codigo`, `enunciado`, `alt_a`..`alt_e`, `correta`), então esta
 *  MESMA função serve os dois formatos e o Pacote ZIP (que reaproveita o
 *  parser V2). Usada tanto no pré-passo puro que coleta os candidatos para
 *  a consulta em lote (`computeRowFingerprint` abaixo) quanto, de novo,
 *  dentro do parser de linha completo (V1/V2) — nenhuma das duas chamadas
 *  faz uma consulta D1; recalcular só custa CPU, e garante que os dois
 *  lugares NUNCA divirjam (mesma função, nunca duas implementações
 *  paralelas do mesmo cálculo). */
export function extractCodeAndFingerprintInputs(
  row: string[],
  headerIndex: Record<string, number>
): { code: string; enunciado: string; alternativas: AlternativeInput[] } {
  const code = cell(row, headerIndex, "codigo");
  const enunciado = cell(row, headerIndex, "enunciado");
  const correta = cell(row, headerIndex, "correta").toUpperCase();
  const alternativas: AlternativeInput[] = QUESTION_ALTERNATIVE_LETTERS.map((letter) => ({
    letter,
    text: cell(row, headerIndex, `alt_${letter.toLowerCase()}`),
    isCorrect: letter === correta,
    distractorExplanation: null,
  }));
  return { code, enunciado, alternativas };
}

/** Pré-passo puro (nenhuma consulta D1) — código + fingerprint de UMA
 *  linha, para alimentar a coleta de candidatos ANTES de montar o
 *  contexto em lote. `fingerprint` vem vazio quando o enunciado está
 *  ausente (mesma regra do parser completo: nunca calcula fingerprint de
 *  enunciado vazio). */
export async function computeRowFingerprint(row: string[], headerIndex: Record<string, number>): Promise<{ code: string; fingerprint: string }> {
  const { code, enunciado, alternativas } = extractCodeAndFingerprintInputs(row, headerIndex);
  const fingerprint = enunciado ? await computeQuestionFingerprint(enunciado, alternativas) : "";
  return { code, fingerprint };
}

/* ------------------------------ Padrões --------------------------------- */

export interface PatternCatalogEntry {
  id: string;
  code: string;
  name: string;
}

export interface PatternResolution {
  pattern: PatternCatalogEntry | null;
  /** `true` quando a chave de busca colide entre DOIS OU MAIS padrões
   *  distintos (ex.: `patterns.name` não tem índice UNIQUE no schema — só
   *  `code`/`slug` têm) — nunca escolhido arbitrariamente; o chamador deve
   *  tratar como erro de validação, nunca como "não encontrado". */
  ambiguous: boolean;
}

const NOT_FOUND: PatternResolution = { pattern: null, ambiguous: false };
const EMPTY: PatternResolution = { pattern: null, ambiguous: false };

/** Catálogo completo de padrões, carregado em UMA consulta, resolvido em
 *  memória a partir daí — nunca uma consulta D1 por linha/padrão
 *  referenciado. */
export class PatternCatalog {
  // CSV V1 (histórico): resolução SÓ por código, sempre exata — `code` tem
  // índice UNIQUE no banco (idx_patterns_code), então esta chave nunca é
  // ambígua estruturalmente.
  private readonly byCodeExact = new Map<string, PatternCatalogEntry>();
  // CSV V2 / Pacote ZIP: resolução por NOME OU CÓDIGO — replica a consulta
  // original (`WHERE name = ? OR code = ?`), que podia (em teoria) casar
  // mais de um padrão distinto já que `name` não é UNIQUE. Diferente da
  // consulta original (que pegava a primeira linha arbitrariamente via
  // `.first()`), esta versão DETECTA a colisão e a reporta como ambígua.
  private readonly byNameOrCodeExact = new Map<string, PatternCatalogEntry[]>();
  private readonly byNameOrCodeLower = new Map<string, PatternCatalogEntry[]>();
  private readonly byId = new Map<string, PatternCatalogEntry>();

  constructor(entries: PatternCatalogEntry[]) {
    for (const entry of entries) {
      this.byId.set(entry.id, entry);
      this.byCodeExact.set(entry.code, entry);
      this.push(this.byNameOrCodeExact, entry.name, entry);
      this.push(this.byNameOrCodeExact, entry.code, entry);
      this.push(this.byNameOrCodeLower, entry.name.toLowerCase(), entry);
      this.push(this.byNameOrCodeLower, entry.code.toLowerCase(), entry);
    }
  }

  private push(map: Map<string, PatternCatalogEntry[]>, key: string, entry: PatternCatalogEntry): void {
    const list = map.get(key);
    if (!list) {
      map.set(key, [entry]);
      return;
    }
    if (!list.some((e) => e.id === entry.id)) list.push(entry);
  }

  private resolveFrom(map: Map<string, PatternCatalogEntry[]>, key: string): PatternResolution | null {
    const matches = map.get(key);
    if (!matches || matches.length === 0) return null;
    if (matches.length > 1) return { pattern: null, ambiguous: true };
    return { pattern: matches[0], ambiguous: false };
  }

  /** CSV V1 — código exato, nunca por nome (compatibilidade histórica). */
  resolveByCodeExact(raw: string): PatternResolution {
    const trimmed = raw.trim();
    if (!trimmed) return EMPTY;
    const found = this.byCodeExact.get(trimmed);
    return found ? { pattern: found, ambiguous: false } : NOT_FOUND;
  }

  /** CSV V2 / Pacote ZIP — nome OU código, exato primeiro (sensível a
   *  maiúsculas/minúsculas, igual à consulta original), depois fallback
   *  case-insensitive. Nunca escolhe arbitrariamente entre padrões
   *  distintos que colidam na mesma chave. */
  resolveByNameOrCode(raw: string): PatternResolution {
    const trimmed = raw.trim();
    if (!trimmed) return EMPTY;
    const exact = this.resolveFrom(this.byNameOrCodeExact, trimmed);
    if (exact) return exact;
    const lower = this.resolveFrom(this.byNameOrCodeLower, trimmed.toLowerCase());
    if (lower) return lower;
    return NOT_FOUND;
  }

  /** Lookup direto por ID — usado, por exemplo, para resolver o NOME de um
   *  padrão já conhecido (ex.: `padroes[].patternId` de uma linha já
   *  validada) sem uma nova consulta D1, já que o catálogo inteiro já está
   *  em memória. */
  getById(id: string): PatternCatalogEntry | null {
    return this.byId.get(id) ?? null;
  }
}

export async function loadPatternCatalog(db: D1Database): Promise<PatternCatalog> {
  const result = await db.prepare("SELECT id, code, name FROM patterns").all<PatternCatalogEntry>();
  return new PatternCatalog(result.results ?? []);
}

/* --------------------------- Códigos/fingerprints ------------------------ */

/** Consulta em lote (chunked, `IN (...)`) — devolve o subconjunto de
 *  `codes` que já existe em `questions.code`. Nunca uma consulta por
 *  código: para N códigos distintos, gera `ceil(N / IN_CLAUSE_CHUNK_SIZE)`
 *  consultas, não N. */
export async function queryExistingCodes(db: D1Database, codes: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const group of chunk(distinctNonEmpty(codes), IN_CLAUSE_CHUNK_SIZE)) {
    const placeholders = group.map(() => "?").join(", ");
    const result = await db.prepare(`SELECT code FROM questions WHERE code IN (${placeholders})`).bind(...group).all<{ code: string }>();
    for (const row of result.results ?? []) found.add(row.code);
  }
  return found;
}

export async function queryExistingFingerprints(db: D1Database, fingerprints: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const group of chunk(distinctNonEmpty(fingerprints), IN_CLAUSE_CHUNK_SIZE)) {
    const placeholders = group.map(() => "?").join(", ");
    const result = await db.prepare(`SELECT fingerprint FROM questions WHERE fingerprint IN (${placeholders})`).bind(...group).all<{ fingerprint: string }>();
    for (const row of result.results ?? []) found.add(row.fingerprint);
  }
  return found;
}

/** Usado só no APPLY (seção 8 da ordem) — revalida quais `pattern_id`s
 *  referenciados pelo lote ainda existem (um padrão pode ter sido
 *  arquivado/removido entre o preview e o apply). */
export async function queryExistingPatternIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const group of chunk(distinctNonEmpty(ids), IN_CLAUSE_CHUNK_SIZE)) {
    const placeholders = group.map(() => "?").join(", ");
    const result = await db.prepare(`SELECT id FROM patterns WHERE id IN (${placeholders})`).bind(...group).all<{ id: string }>();
    for (const row of result.results ?? []) found.add(row.id);
  }
  return found;
}

/* ------------------------------- Contexto -------------------------------- */

/** Contexto de validação em lote — construído UMA vez por preview (ou por
 *  apply, na revalidação), nunca reconstruído por linha. Os parsers de
 *  linha (V1/V2) consultam isto de forma síncrona/em memória. */
export interface ImportValidationContext {
  patterns: PatternCatalog;
  existingCodes: Set<string>;
  existingFingerprints: Set<string>;
}

/** Monta o contexto completo para o PREVIEW: catálogo de padrões inteiro +
 *  existência em lote dos códigos/fingerprints efetivamente presentes no
 *  arquivo (coletados num pré-passo puro, sem D1, antes de chamar isto —
 *  ver `previewImport`/`previewPackage`). */
export async function buildImportValidationContext(db: D1Database, codes: string[], fingerprints: string[]): Promise<ImportValidationContext> {
  const patterns = await loadPatternCatalog(db);
  const existingCodes = await queryExistingCodes(db, codes);
  const existingFingerprints = await queryExistingFingerprints(db, fingerprints);
  return { patterns, existingCodes, existingFingerprints };
}

/* --------------------------- Revalidação no APPLY ------------------------ */

export interface ApplyRevalidationSets {
  existingCodes: Set<string>;
  existingFingerprints: Set<string>;
  existingPatternIds: Set<string>;
}

/** Seção 8 da ordem — substitui o laço `for (row) { findQuestionByCode;
 *  findQuestionsByFingerprint; SELECT COUNT patterns }` por três consultas
 *  em lote (chunked), calculadas UMA vez sobre TODOS os codes/
 *  fingerprints/patternIds do lote inteiro — nunca por linha. O chamador
 *  ainda itera as linhas EM MEMÓRIA, na mesma ordem de antes, para decidir
 *  qual foi o primeiro conflito (preserva mensagens/comportamento). */
export async function loadApplyRevalidationSets(
  db: D1Database,
  input: { codes: string[]; fingerprints: string[]; patternIds: string[] }
): Promise<ApplyRevalidationSets> {
  const existingCodes = await queryExistingCodes(db, input.codes);
  const existingFingerprints = await queryExistingFingerprints(db, input.fingerprints);
  const existingPatternIds = await queryExistingPatternIds(db, input.patternIds);
  return { existingCodes, existingFingerprints, existingPatternIds };
}

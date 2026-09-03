/* Repositório do catálogo de padrões ENEM — Sprint 6 v1.0.

   ESTE REPOSITÓRIO É 100% SOMENTE LEITURA. Não existe aqui nenhum
   INSERT/UPDATE/DELETE, nem nenhum "build*Statement" para db.batch():
   os três endpoints da sprint são GETs e nenhum deles pode criar padrão,
   atributo, relação ou linha de progresso como efeito colateral (seção 4.2
   da ordem: "nenhum GET cria fixture ou progresso").

   Todas as consultas são parametrizadas; nomes de tabela/coluna são sempre
   literais fixos no código-fonte. O escopo por usuário (`user_id = ?`) está
   sempre no WHERE do SQL — nunca só na camada de aplicação. */

import {
  STUDENT_VISIBLE_EDITORIAL_STATUS,
  type PatternAttributeType,
  type PatternEvidenceFilter,
  type PatternRelationType,
  type PatternSort,
} from "../lib/patternsValidation";
import { isLocalPatternFixturesAllowed, type Env } from "../env";

export interface PatternRow {
  id: string;
  code: string;
  slug: string;
  name: string;
  recognition_phrase: string;
  description: string;
  main_strategy: string;
  introductory_example: string;
  strategic_summary: string;
  editorial_status: string;
  version: number;
  is_local_fixture: number;
  created_at: string;
  updated_at: string;
}

export interface PatternAttributeRow {
  id: string;
  pattern_id: string;
  attribute_type: PatternAttributeType;
  position: number;
  content: string;
}

/** Relação já resolvida para o padrão de destino — só destinos publicados
 *  entram (uma relação apontando para um rascunho editorial nunca aparece,
 *  nem sequer como "existe algo aqui"). */
export interface PatternRelationTargetRow {
  relation_type: PatternRelationType;
  code: string;
  slug: string;
  name: string;
}

export interface StudentPatternProgressRow {
  user_id: string;
  pattern_id: string;
  last_practiced_at: string | null;
  next_review_at: string | null;
  raw_evidence_count: number;
  recognition_index: number | null;
  resolution_index: number | null;
  mastery_index: number | null;
}

export interface PatternListFilters {
  search: string | null;
  content: string | null;
  tag: string | null;
  evidence: PatternEvidenceFilter;
  sort: PatternSort;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** Escapa os curingas do LIKE para que uma busca por "50%" não vire um
 *  curinga acidental. O `\` é declarado com ESCAPE na própria cláusula. */
function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Monta a cláusula WHERE compartilhada por contagem e listagem — mantém as
 *  duas consultas garantidamente coerentes (o total da paginação nunca
 *  diverge da página retornada). `userId` é sempre exigido: mesmo quando o
 *  filtro de evidência é "todos", o LEFT JOIN de progresso é escopado ao
 *  dono da sessão. */
function buildFilterClause(
  filters: PatternListFilters,
  userId: string,
  includeFixtures: boolean
): { sql: string; params: unknown[] } {
  const conditions: string[] = ["p.editorial_status = ?"];
  const params: unknown[] = [STUDENT_VISIBLE_EDITORIAL_STATUS];
  // Sprint 16 v1.3, seção 1/3 da ordem — fora do dev local com a flag
  // explícita (produção real, ou dev local sem a flag), nunca mostra uma
  // fixture local ao aluno, mesmo que ela esteja `published` (as 5
  // fixtures de patterns-fixtures.local.sql SÃO publicadas por desenho —
  // sem este filtro, elas apareceriam misturadas com conteúdo real assim
  // que o gate de rota abrisse para produção). `includeFixtures` preserva
  // byte a byte o comportamento de dev local com a flag (nenhuma condição
  // extra), exatamente como diagnosticRepository.ts/scheduleRepository.ts.
  if (!includeFixtures) conditions.push("p.is_local_fixture = 0");

  if (filters.search !== null) {
    conditions.push(
      `(p.name LIKE ? ESCAPE '\\' OR p.code LIKE ? ESCAPE '\\' OR p.recognition_phrase LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')`
    );
    const term = likeTerm(filters.search);
    params.push(term, term, term, term);
  }

  if (filters.content !== null) {
    conditions.push(
      `EXISTS (SELECT 1 FROM pattern_attributes a WHERE a.pattern_id = p.id AND a.attribute_type = 'required_content' AND a.content = ?)`
    );
    params.push(filters.content);
  }

  if (filters.tag !== null) {
    conditions.push(
      `EXISTS (SELECT 1 FROM pattern_attributes a WHERE a.pattern_id = p.id AND a.attribute_type = 'tag' AND a.content = ?)`
    );
    params.push(filters.tag);
  }

  if (filters.evidence === "com_evidencia" || filters.evidence === "sem_evidencia") {
    const existsProgress = `EXISTS (
      SELECT 1 FROM student_pattern_progress sp
      WHERE sp.pattern_id = p.id AND sp.user_id = ?
        AND (sp.recognition_index IS NOT NULL OR sp.resolution_index IS NOT NULL OR sp.mastery_index IS NOT NULL)
    )`;
    conditions.push(filters.evidence === "com_evidencia" ? existsProgress : `NOT ${existsProgress}`);
    params.push(userId);
  }

  return { sql: conditions.join(" AND "), params };
}

/** Ordenação SEMPRE determinística: a chave escolhida, depois `code`, depois
 *  `id` — nunca ordem física/de inserção, mesmo com nomes ou códigos
 *  repetidos. */
function orderByClause(sort: PatternSort): string {
  return sort === "nome"
    ? "ORDER BY p.name ASC, p.code ASC, p.id ASC"
    : "ORDER BY p.code ASC, p.name ASC, p.id ASC";
}

export async function countPublishedPatterns(
  db: D1Database,
  userId: string,
  filters: PatternListFilters,
  includeFixtures: boolean
): Promise<number> {
  const where = buildFilterClause(filters, userId, includeFixtures);
  const row = await db
    .prepare(`SELECT COUNT(*) as total FROM patterns p WHERE ${where.sql}`)
    .bind(...where.params)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function listPublishedPatterns(
  db: D1Database,
  userId: string,
  filters: PatternListFilters,
  limit: number,
  offset: number,
  includeFixtures: boolean
): Promise<PatternRow[]> {
  const where = buildFilterClause(filters, userId, includeFixtures);
  const result = await db
    .prepare(
      `SELECT p.* FROM patterns p WHERE ${where.sql} ${orderByClause(filters.sort)} LIMIT ? OFFSET ?`
    )
    .bind(...where.params, limit, offset)
    .all<PatternRow>();
  return result.results ?? [];
}

/** Um padrão só é encontrável pelo aluno se estiver `published`. Slug
 *  inexistente e slug de rascunho retornam exatamente a mesma coisa (null) —
 *  a rota converte os dois no MESMO 404, sem vazar a existência do
 *  rascunho. Sprint 16 v1.3 — `includeFixtures` (mesmo raciocínio de
 *  buildFilterClause acima): fora do dev local com a flag, um slug de
 *  fixture local também responde 404, nunca revela conteúdo. */
export async function findPublishedPatternBySlug(db: D1Database, slug: string, includeFixtures: boolean): Promise<PatternRow | null> {
  const fixtureClause = includeFixtures ? "" : " AND is_local_fixture = 0";
  const row = await db
    .prepare(`SELECT * FROM patterns WHERE slug = ? AND editorial_status = ?${fixtureClause}`)
    .bind(slug, STUDENT_VISIBLE_EDITORIAL_STATUS)
    .first<PatternRow>();
  return row ?? null;
}

/** Sprint 8 v1.1 — mesma regra de `findPublishedPatternBySlug`, mas por
 *  `id` (usado pelo Player, que referencia padrões por id via
 *  `question_patterns`/`question_attempts.recognition_pattern_id`, nunca
 *  por slug). Um id inexistente e um id de rascunho retornam exatamente a
 *  mesma coisa (null) — nunca revela a existência de um padrão não
 *  publicado. */
export async function findPublishedPatternById(db: D1Database, id: string): Promise<PatternRow | null> {
  const row = await db
    .prepare("SELECT * FROM patterns WHERE id = ? AND editorial_status = ?")
    .bind(id, STUDENT_VISIBLE_EDITORIAL_STATUS)
    .first<PatternRow>();
  return row ?? null;
}

export async function listAttributesForPatterns(
  db: D1Database,
  patternIds: string[]
): Promise<PatternAttributeRow[]> {
  if (patternIds.length === 0) return [];
  const result = await db
    .prepare(
      `SELECT id, pattern_id, attribute_type, position, content
       FROM pattern_attributes
       WHERE pattern_id IN (${placeholders(patternIds.length)})
       ORDER BY pattern_id ASC, attribute_type ASC, position ASC, id ASC`
    )
    .bind(...patternIds)
    .all<PatternAttributeRow>();
  return result.results ?? [];
}

/** Relações que SAEM deste padrão, já resolvidas para o padrão de destino e
 *  restritas a destinos publicados. Ordenação determinística. Sprint 16
 *  v1.3 — `includeFixtures` (mesmo raciocínio das funções acima): fora do
 *  dev local com a flag, uma relação apontando para um padrão de fixture
 *  nunca aparece. */
export async function listRelationsForPattern(
  db: D1Database,
  patternId: string,
  includeFixtures: boolean
): Promise<PatternRelationTargetRow[]> {
  const fixtureClause = includeFixtures ? "" : " AND target.is_local_fixture = 0";
  const result = await db
    .prepare(
      `SELECT r.relation_type, target.code, target.slug, target.name
       FROM pattern_relations r
       JOIN patterns target ON target.id = r.to_pattern_id
       WHERE r.from_pattern_id = ? AND target.editorial_status = ?${fixtureClause}
       ORDER BY r.relation_type ASC, target.code ASC, target.id ASC`
    )
    .bind(patternId, STUDENT_VISIBLE_EDITORIAL_STATUS)
    .all<PatternRelationTargetRow>();
  return result.results ?? [];
}

/** Sprint 16 v1.3, seção 2 da ordem — "disponível quando existir pelo
 *  menos padrão REAL publicado/elegível": mesma regra de
 *  questionRepository.ts:hasAnyPublishedQuestion, aplicada a `patterns`. */
export async function hasAnyRealPublishedPattern(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 as found FROM patterns WHERE editorial_status = ? AND is_local_fixture = 0 LIMIT 1")
    .bind(STUDENT_VISIBLE_EDITORIAL_STATUS)
    .first<{ found: number }>();
  return row !== null;
}

/** Sprint 16 v1.3, seção 1 da ordem — critério ÚNICO de disponibilidade do
 *  catálogo de Padrões, mesmo desenho de
 *  questionRepository.ts:isQuestionBankAvailable/diagnosticRepository.ts:
 *  isDiagnosticAvailable/scheduleRepository.ts:isScheduleAvailable. */
export async function isPatternsAvailable(env: Env, url: URL, db: D1Database): Promise<boolean> {
  if (isLocalPatternFixturesAllowed(env, url)) return true;
  return hasAnyRealPublishedPattern(db);
}

/** Progresso de UM aluno num padrão. Retorna null quando a linha não existe
 *  — e NUNCA cria a linha (seção 4.2 da ordem). O escopo por dono está no
 *  WHERE do SQL (`user_id = ?`), não só na aplicação. */
export async function findStudentPatternProgress(
  db: D1Database,
  userId: string,
  patternId: string
): Promise<StudentPatternProgressRow | null> {
  const row = await db
    .prepare(
      `SELECT user_id, pattern_id, last_practiced_at, next_review_at, raw_evidence_count,
              recognition_index, resolution_index, mastery_index
       FROM student_pattern_progress
       WHERE user_id = ? AND pattern_id = ?`
    )
    .bind(userId, patternId)
    .first<StudentPatternProgressRow>();
  return row ?? null;
}

export async function listStudentPatternProgress(
  db: D1Database,
  userId: string,
  patternIds: string[]
): Promise<StudentPatternProgressRow[]> {
  if (patternIds.length === 0) return [];
  const result = await db
    .prepare(
      `SELECT user_id, pattern_id, last_practiced_at, next_review_at, raw_evidence_count,
              recognition_index, resolution_index, mastery_index
       FROM student_pattern_progress
       WHERE user_id = ? AND pattern_id IN (${placeholders(patternIds.length)})`
    )
    .bind(userId, ...patternIds)
    .all<StudentPatternProgressRow>();
  return result.results ?? [];
}

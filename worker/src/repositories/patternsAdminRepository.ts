/* Repositório ADMINISTRATIVO do catálogo de padrões — Sprint 16 v1.2, seção
   4 da ordem: emenda explícita do charter de patternsRepository.ts
   ("100% somente leitura", Sprint 6). A emenda NÃO torna
   patternsRepository.ts mutável — cria esta superfície SEPARADA,
   exclusivamente administrativa, nunca alcançável pelo fluxo do
   aluno/professor. Isolamento explícito pedido pela ordem: "preferir novo
   repository/service admin de catálogo de padrões... isolamento claro
   entre leitura pedagógica e gestão administrativa".

   Toda escrita aqui SEMPRE grava `is_local_fixture = 0` (nunca cria
   fixture). Concorrência: `patterns.version` JÁ existe desde a migration
   0007 especificamente para isto (comentário original da migração:
   "não há endpoint editorial nesta sprint, mas o campo já existe para
   quando houver") — esta é essa mutação; UPDATE/transições são sempre
   guardados por `expectedVersion`, mesmo idioma do resto do projeto
   (questionRepository.ts). */

export interface AdminPatternRow {
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

export interface AdminPatternAttributeRow {
  id: string;
  pattern_id: string;
  attribute_type: string;
  position: number;
  content: string;
}

export async function listRealPatterns(db: D1Database): Promise<AdminPatternRow[]> {
  const result = await db.prepare("SELECT * FROM patterns WHERE is_local_fixture = 0 ORDER BY code ASC, id ASC").all<AdminPatternRow>();
  return result.results ?? [];
}

export async function findRealPatternById(db: D1Database, id: string): Promise<AdminPatternRow | null> {
  const row = await db.prepare("SELECT * FROM patterns WHERE id = ? AND is_local_fixture = 0").bind(id).first<AdminPatternRow>();
  return row ?? null;
}

export async function listAttributesForPattern(db: D1Database, patternId: string): Promise<AdminPatternAttributeRow[]> {
  const result = await db
    .prepare("SELECT * FROM pattern_attributes WHERE pattern_id = ? ORDER BY attribute_type ASC, position ASC")
    .bind(patternId)
    .all<AdminPatternAttributeRow>();
  return result.results ?? [];
}

export interface PatternCoreFields {
  code: string;
  slug: string;
  name: string;
  recognitionPhrase: string;
  description: string;
  mainStrategy: string;
  introductoryExample: string;
  strategicSummary: string;
}

export function buildInsertPatternStatement(db: D1Database, id: string, fields: PatternCoreFields): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO patterns
         (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status, version, is_local_fixture)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, 0)`
    )
    .bind(id, fields.code, fields.slug, fields.name, fields.recognitionPhrase, fields.description, fields.mainStrategy, fields.introductoryExample, fields.strategicSummary);
}

export function buildInsertAttributeStatement(
  db: D1Database,
  params: { id: string; patternId: string; attributeType: string; position: number; content: string }
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO pattern_attributes (id, pattern_id, attribute_type, position, content) VALUES (?, ?, ?, ?, ?)")
    .bind(params.id, params.patternId, params.attributeType, params.position, params.content);
}

export function buildDeleteAttributesStatement(db: D1Database, patternId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM pattern_attributes WHERE pattern_id = ?").bind(patternId);
}

/** UPDATE dos campos essenciais — guardado por `id` + `version` exata +
 *  `is_local_fixture = 0` (nunca edita fixture através deste pipeline).
 *  `version = version + 1` no MESMO statement, mesmo idioma de
 *  questionRepository.ts:buildUpdateQuestionCoreStatement. */
export function buildUpdatePatternCoreStatement(db: D1Database, id: string, expectedVersion: number, fields: PatternCoreFields): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE patterns SET
         code = ?, slug = ?, name = ?, recognition_phrase = ?, description = ?,
         main_strategy = ?, introductory_example = ?, strategic_summary = ?,
         version = version + 1, updated_at = datetime('now')
       WHERE id = ? AND version = ? AND is_local_fixture = 0`
    )
    .bind(
      fields.code,
      fields.slug,
      fields.name,
      fields.recognitionPhrase,
      fields.description,
      fields.mainStrategy,
      fields.introductoryExample,
      fields.strategicSummary,
      id,
      expectedVersion
    );
}

const ALLOWED_STATUS_TRANSITIONS: Record<string, string[]> = {
  publish: ["draft", "in_review", "changes_requested", "approved", "archived"],
  inactivate: ["published"],
};

/** Transição de status guardada por `id` + `version` exata +
 *  `is_local_fixture = 0` + status de origem elegível — mesmo idioma de
 *  questionRepository.ts:buildTransitionStatement. `publish`/`inactivate`
 *  são os DOIS únicos verbos desta sprint (seção 4 da ordem: "publicar/
 *  inativar padrão" — nenhum workflow de revisão em várias etapas). */
export function buildTransitionStatusStatement(
  db: D1Database,
  params: { id: string; expectedVersion: number; action: "publish" | "inactivate" }
): D1PreparedStatement {
  const toStatus = params.action === "publish" ? "published" : "archived";
  const fromStatuses = ALLOWED_STATUS_TRANSITIONS[params.action];
  const placeholders = fromStatuses.map(() => "?").join(", ");
  return db
    .prepare(
      `UPDATE patterns SET editorial_status = ?, version = version + 1, updated_at = datetime('now')
       WHERE id = ? AND version = ? AND is_local_fixture = 0 AND editorial_status IN (${placeholders})`
    )
    .bind(toStatus, params.id, params.expectedVersion, ...fromStatuses);
}

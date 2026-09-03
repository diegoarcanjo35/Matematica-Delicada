/* Serviço ADMINISTRATIVO do catálogo de padrões — Sprint 16 v1.2, seção 4
   da ordem (emenda do charter). Mesmo contrato de autorização dos outros
   dois pipelines desta sprint (requireAdminRole). CREATE usa a MESMA
   identidade mutationId = id (diagnosticAdminService.ts); UPDATE/transição
   de status usam guarda de `version` (o padrão já tinha essa coluna
   reservada para isto desde a Sprint 6). Sem score, TRI ou fórmula de
   domínio (seção 4 da ordem) — nada aqui toca índices pedagógicos. */

import { requireAdminRole } from "./adminService";
import {
  buildDeleteAttributesStatement,
  buildInsertAttributeStatement,
  buildInsertPatternStatement,
  buildTransitionStatusStatement,
  buildUpdatePatternCoreStatement,
  findRealPatternById,
  listAttributesForPattern,
  listRealPatterns,
  type AdminPatternRow,
  type PatternCoreFields,
} from "../repositories/patternsAdminRepository";
import { buildAuditEventStatement, type AuditEventType } from "../repositories/auditRepository";
import { isValidMutationId } from "../lib/questionsValidation";
import {
  ATTRIBUTE_FIELD_TO_TYPE,
  validateAttributeLists,
  validateExpectedVersion,
  validateIntroductoryExample,
  validateMainStrategy,
  validatePatternCode,
  validatePatternDescription,
  validatePatternName,
  validatePatternSlugInput,
  validateRecognitionPhrase,
  validateStrategicSummary,
  type PatternAttributeLists,
} from "../lib/patternsAdminValidation";

export interface PatternAdminDto {
  id: string;
  code: string;
  slug: string;
  name: string;
  recognitionPhrase: string;
  description: string;
  mainStrategy: string;
  introductoryExample: string;
  strategicSummary: string;
  editorialStatus: string;
  version: number;
  attributes: PatternAttributeLists;
  createdAt: string;
  updatedAt: string;
}

function attributesToDto(rows: Awaited<ReturnType<typeof listAttributesForPattern>>): PatternAttributeLists {
  const result: PatternAttributeLists = {
    frequentClues: [],
    recurringPhrases: [],
    recurringVisualElements: [],
    alternativeStrategies: [],
    requiredContents: [],
    prerequisiteContents: [],
    commonMistakes: [],
    tags: [],
  };
  for (const [field, type] of Object.entries(ATTRIBUTE_FIELD_TO_TYPE) as [keyof PatternAttributeLists, string][]) {
    result[field] = rows.filter((r) => r.attribute_type === type).map((r) => r.content);
  }
  return result;
}

async function toDto(db: D1Database, row: AdminPatternRow): Promise<PatternAdminDto> {
  const attributeRows = await listAttributesForPattern(db, row.id);
  return {
    id: row.id,
    code: row.code,
    slug: row.slug,
    name: row.name,
    recognitionPhrase: row.recognition_phrase,
    description: row.description,
    mainStrategy: row.main_strategy,
    introductoryExample: row.introductory_example,
    strategicSummary: row.strategic_summary,
    editorialStatus: row.editorial_status,
    version: row.version,
    attributes: attributesToDto(attributeRows),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type ListResult = { ok: true; patterns: PatternAdminDto[] } | { ok: false; forbidden: true };

export async function listPatterns(db: D1Database, adminId: string): Promise<ListResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };
  const rows = await listRealPatterns(db);
  const dtos = await Promise.all(rows.map((row) => toDto(db, row)));
  return { ok: true, patterns: dtos };
}

interface RawCoreInput {
  code: unknown;
  slug: unknown;
  name: unknown;
  recognitionPhrase: unknown;
  description: unknown;
  mainStrategy: unknown;
  introductoryExample: unknown;
  strategicSummary: unknown;
  attributes: unknown;
}

function validateCore(input: RawCoreInput): { ok: true; fields: PatternCoreFields; attributes: PatternAttributeLists } | { ok: false; fieldErrors: Record<string, string> } {
  const code = validatePatternCode(input.code);
  if (!code.ok) return { ok: false, fieldErrors: { code: code.error! } };
  const slug = validatePatternSlugInput(input.slug);
  if (!slug.ok) return { ok: false, fieldErrors: { slug: slug.error! } };
  const name = validatePatternName(input.name);
  if (!name.ok) return { ok: false, fieldErrors: { name: name.error! } };
  const recognitionPhrase = validateRecognitionPhrase(input.recognitionPhrase);
  if (!recognitionPhrase.ok) return { ok: false, fieldErrors: { recognitionPhrase: recognitionPhrase.error! } };
  const description = validatePatternDescription(input.description);
  if (!description.ok) return { ok: false, fieldErrors: { description: description.error! } };
  const mainStrategy = validateMainStrategy(input.mainStrategy);
  if (!mainStrategy.ok) return { ok: false, fieldErrors: { mainStrategy: mainStrategy.error! } };
  const introductoryExample = validateIntroductoryExample(input.introductoryExample);
  if (!introductoryExample.ok) return { ok: false, fieldErrors: { introductoryExample: introductoryExample.error! } };
  const strategicSummary = validateStrategicSummary(input.strategicSummary);
  if (!strategicSummary.ok) return { ok: false, fieldErrors: { strategicSummary: strategicSummary.error! } };
  const attributes = validateAttributeLists(input.attributes);
  if (!attributes.ok) return { ok: false, fieldErrors: { attributes: attributes.error! } };

  return {
    ok: true,
    fields: {
      code: code.value!,
      slug: slug.value!,
      name: name.value!,
      recognitionPhrase: recognitionPhrase.value!,
      description: description.value!,
      mainStrategy: mainStrategy.value!,
      introductoryExample: introductoryExample.value!,
      strategicSummary: strategicSummary.value!,
    },
    attributes: attributes.value!,
  };
}

function attributeStatements(db: D1Database, patternId: string, attributes: PatternAttributeLists): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const [field, type] of Object.entries(ATTRIBUTE_FIELD_TO_TYPE) as [keyof PatternAttributeLists, string][]) {
    attributes[field].forEach((content, index) => {
      statements.push(buildInsertAttributeStatement(db, { id: `${patternId}-${type}-${index}`, patternId, attributeType: type, position: index, content }));
    });
  }
  return statements;
}

function coreEqual(a: PatternCoreFields, existing: AdminPatternRow): boolean {
  return (
    a.code === existing.code &&
    a.slug === existing.slug &&
    a.name === existing.name &&
    a.recognitionPhrase === existing.recognition_phrase &&
    a.description === existing.description &&
    a.mainStrategy === existing.main_strategy &&
    a.introductoryExample === existing.introductory_example &&
    a.strategicSummary === existing.strategic_summary
  );
}

export type CreateResult =
  | { ok: true; changed: boolean; patternId: string }
  | { ok: false; forbidden: true }
  | { ok: false; conflict: true }
  | { ok: false; fieldErrors: Record<string, string> };

export async function createPattern(db: D1Database, adminId: string, input: RawCoreInput & { mutationId: unknown }): Promise<CreateResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };
  if (!isValidMutationId(input.mutationId)) return { ok: false, fieldErrors: { mutationId: "mutationId é obrigatório e precisa ser um UUID válido." } };
  const mutationId = input.mutationId;

  const validated = validateCore(input);
  if (!validated.ok) return { ok: false, fieldErrors: validated.fieldErrors };
  const { fields, attributes } = validated;

  try {
    await db.batch([
      buildInsertPatternStatement(db, mutationId, fields),
      ...attributeStatements(db, mutationId, attributes),
      buildAuditEventStatement(db, { id: mutationId, eventType: "admin_pattern_created", userId: adminId, metadata: { patternId: mutationId } }),
    ]);
  } catch (error) {
    const existing = await findRealPatternById(db, mutationId);
    if (existing && coreEqual(fields, existing)) return { ok: true, changed: false, patternId: mutationId };
    if (existing) return { ok: false, conflict: true };
    // Não foi retry do próprio mutationId — provavelmente `code`/`slug` já
    // usados por outro padrão (UNIQUE, migration 0007). Nunca uma exceção
    // crua chegando ao chamador.
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      // Formato real do driver: "UNIQUE constraint failed: patterns.code" /
      // "patterns.slug" (nome da tabela.coluna, nunca o nome do índice).
      if (error.message.includes("patterns.code")) return { ok: false, fieldErrors: { code: "Já existe um padrão com este código." } };
      if (error.message.includes("patterns.slug")) return { ok: false, fieldErrors: { slug: "Já existe um padrão com este slug." } };
    }
    throw error;
  }

  return { ok: true, changed: true, patternId: mutationId };
}

export type UpdateResult =
  | { ok: true; changed: boolean }
  | { ok: false; forbidden: true }
  | { ok: false; notFound: true }
  | { ok: false; conflict: true }
  | { ok: false; fieldErrors: Record<string, string> };

export async function updatePattern(
  db: D1Database,
  adminId: string,
  patternId: string,
  input: RawCoreInput & { mutationId: unknown; expectedVersion: unknown }
): Promise<UpdateResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };
  if (!isValidMutationId(input.mutationId)) return { ok: false, fieldErrors: { mutationId: "mutationId é obrigatório e precisa ser um UUID válido." } };
  const mutationId = input.mutationId;
  const expectedVersion = validateExpectedVersion(input.expectedVersion);
  if (!expectedVersion.ok) return { ok: false, fieldErrors: { expectedVersion: expectedVersion.error! } };

  const existing = await findRealPatternById(db, patternId);
  if (!existing) return { ok: false, notFound: true };

  const validated = validateCore(input);
  if (!validated.ok) return { ok: false, fieldErrors: validated.fieldErrors };
  const { fields, attributes } = validated;

  const existingAttributeRows = await listAttributesForPattern(db, patternId);
  const attributesUnchanged = JSON.stringify(attributesToDto(existingAttributeRows)) === JSON.stringify(attributes);
  if (coreEqual(fields, existing) && attributesUnchanged) return { ok: true, changed: false };

  if (existing.version !== expectedVersion.value) return { ok: false, conflict: true };

  try {
    const result = await db.batch([
      buildUpdatePatternCoreStatement(db, patternId, expectedVersion.value!, fields),
      buildDeleteAttributesStatement(db, patternId),
      ...attributeStatements(db, patternId, attributes),
      buildAuditEventStatement(db, { id: mutationId, eventType: "admin_pattern_updated", userId: adminId, metadata: { patternId } }),
    ]);
    if (result[0].meta.changes !== 1) {
      const after = await findRealPatternById(db, patternId);
      if (!after) return { ok: false, notFound: true };
      return { ok: false, conflict: true };
    }
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      // Formato real do driver: "UNIQUE constraint failed: patterns.code" /
      // "patterns.slug" (nome da tabela.coluna, nunca o nome do índice).
      if (error.message.includes("patterns.code")) return { ok: false, fieldErrors: { code: "Já existe um padrão com este código." } };
      if (error.message.includes("patterns.slug")) return { ok: false, fieldErrors: { slug: "Já existe um padrão com este slug." } };
      if (error.message.includes("audit_log")) return { ok: false, conflict: true };
    }
    throw error;
  }

  return { ok: true, changed: true };
}

export type TransitionResult =
  | { ok: true; changed: boolean }
  | { ok: false; forbidden: true }
  | { ok: false; notFound: true }
  | { ok: false; conflict: true }
  | { ok: false; fieldErrors: Record<string, string> };

export async function transitionStatus(
  db: D1Database,
  adminId: string,
  patternId: string,
  input: { action: unknown; expectedVersion: unknown; mutationId: unknown }
): Promise<TransitionResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };
  if (input.action !== "publish" && input.action !== "inactivate") {
    return { ok: false, fieldErrors: { action: "action deve ser 'publish' ou 'inactivate'." } };
  }
  if (!isValidMutationId(input.mutationId)) return { ok: false, fieldErrors: { mutationId: "mutationId é obrigatório e precisa ser um UUID válido." } };
  const expectedVersion = validateExpectedVersion(input.expectedVersion);
  if (!expectedVersion.ok) return { ok: false, fieldErrors: { expectedVersion: expectedVersion.error! } };

  const existing = await findRealPatternById(db, patternId);
  if (!existing) return { ok: false, notFound: true };
  if (existing.version !== expectedVersion.value) return { ok: false, conflict: true };

  const eventType: AuditEventType = input.action === "publish" ? "admin_pattern_published" : "admin_pattern_inactivated";

  try {
    const result = await db.batch([
      buildTransitionStatusStatement(db, { id: patternId, expectedVersion: expectedVersion.value!, action: input.action }),
      buildAuditEventStatement(db, { id: input.mutationId, eventType, userId: adminId, metadata: { patternId } }),
    ]);
    if (result[0].meta.changes !== 1) {
      const after = await findRealPatternById(db, patternId);
      if (!after) return { ok: false, notFound: true };
      const alreadyInTargetStatus = input.action === "publish" ? after.editorial_status === "published" : after.editorial_status === "archived";
      if (alreadyInTargetStatus) return { ok: true, changed: false };
      return { ok: false, conflict: true };
    }
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes("audit_log")) {
      return { ok: false, conflict: true };
    }
    throw error;
  }

  return { ok: true, changed: true };
}

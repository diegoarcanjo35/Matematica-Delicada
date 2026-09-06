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
  generatePatternSlugFromName,
  normalizePatternName,
  validateAttributeLists,
  validateExpectedVersion,
  validateOptionalIntroductoryExample,
  validateOptionalMainStrategy,
  validateOptionalName,
  validateOptionalPatternDescription,
  validateOptionalRecognitionPhrase,
  validateOptionalStrategicSummary,
  validatePatternName,
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

/* Sprint 17, seção B da ordem — leitura mínima para o Banco de Questões
   (editor/admin) montar os chips de "padrão principal". Sem guarda de
   `requireAdminRole` aqui de propósito: quem chama (rota
   /api/editorial/patterns) já validou `editor`/`admin` via
   requireEditorialActor/resolveEditorialRole ANTES de chegar aqui — este
   pipeline nunca depende de /api/admin/patterns nem do papel `admin`
   isoladamente (ordem: "não faça a página depender de
   /api/admin/patterns, pois isso quebraria usuários com papel editor").
   Devolve só o essencial (id/nome/situação) — nunca a complexidade
   administrativa completa (código/slug/atributos/etc.). */
export interface EditorialPatternSummary {
  id: string;
  name: string;
  editorialStatus: string;
}

export async function listPatternsForEditorial(db: D1Database): Promise<EditorialPatternSummary[]> {
  const rows = await listRealPatterns(db);
  return rows
    .map((row) => ({ id: row.id, name: row.name, editorialStatus: row.editorial_status }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

/* Sprint 17, seção A da ordem — `code`/`slug` deixam de ser fornecidos pela
   usuária (ela nunca mais vê esses campos) e passam a ser gerados pelo
   SISTEMA. `code` é o próprio `id` do padrão (o `mutationId`, um UUID
   gerado no cliente e validado por isValidMutationId) — único, estável,
   nunca depende de edição manual, e nunca aparece na UI.

   Sprint 17.1, item 2 da ordem de auditoria — `slug` deixou de ser só
   `padrao-<id>` (ilegível) e passou a ser gerado a partir do NOME
   (generatePatternSlugFromName, patternsAdminValidation.ts), ex.: "Mediana,
   moda e frequência" -> "mediana-moda-e-frequencia". Continua só no
   CREATE: o slug nunca é recalculado no UPDATE, mesmo que o nome mude
   depois — updatePattern abaixo sempre herda `existing.slug`,
   preservando qualquer URL/referência já publicada. */
function generatePatternCode(id: string): string {
  return id;
}

interface RawPatternInput {
  name?: unknown;
  mainStrategy?: unknown;
  recognitionPhrase?: unknown;
  description?: unknown;
  introductoryExample?: unknown;
  strategicSummary?: unknown;
  attributes?: unknown;
}

/* CREATE: só `name` é obrigatório (seção A: "um rascunho pode existir
   apenas com o nome"). Todo o resto — inclusive os campos legados que a
   UI nova nunca envia — é opcional e vira string vazia quando ausente
   (colunas TEXT NOT NULL aceitam '' sem violar o schema; nunca fabricamos
   conteúdo pedagógico para preenchê-las). Quem ainda envia o payload
   legado completo (compatibilidade) continua funcionando normalmente —
   os valores só não são mais exigidos. */
function validateCreateInput(
  input: RawPatternInput
): { ok: true; fields: Omit<PatternCoreFields, "code" | "slug">; attributes: PatternAttributeLists } | { ok: false; fieldErrors: Record<string, string> } {
  const name = validatePatternName(input.name);
  if (!name.ok) return { ok: false, fieldErrors: { name: name.error! } };
  const mainStrategy = validateOptionalMainStrategy(input.mainStrategy);
  if (!mainStrategy.ok) return { ok: false, fieldErrors: { mainStrategy: mainStrategy.error! } };
  const recognitionPhrase = validateOptionalRecognitionPhrase(input.recognitionPhrase);
  if (!recognitionPhrase.ok) return { ok: false, fieldErrors: { recognitionPhrase: recognitionPhrase.error! } };
  const description = validateOptionalPatternDescription(input.description);
  if (!description.ok) return { ok: false, fieldErrors: { description: description.error! } };
  const introductoryExample = validateOptionalIntroductoryExample(input.introductoryExample);
  if (!introductoryExample.ok) return { ok: false, fieldErrors: { introductoryExample: introductoryExample.error! } };
  const strategicSummary = validateOptionalStrategicSummary(input.strategicSummary);
  if (!strategicSummary.ok) return { ok: false, fieldErrors: { strategicSummary: strategicSummary.error! } };
  const attributes = validateAttributeLists(input.attributes);
  if (!attributes.ok) return { ok: false, fieldErrors: { attributes: attributes.error! } };

  return {
    ok: true,
    fields: {
      name: name.value!,
      recognitionPhrase: recognitionPhrase.value ?? "",
      description: description.value ?? "",
      mainStrategy: mainStrategy.value ?? "",
      introductoryExample: introductoryExample.value ?? "",
      strategicSummary: strategicSummary.value ?? "",
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

/* Sprint 17.1, item 1 da ordem de auditoria — dois padrões reais nunca
   podem coexistir com o mesmo nome pedagógico "por acidente" (maiúscula/
   minúscula, espaço, forma Unicode). Comparação feita em memória sobre os
   padrões REAIS já carregados (nunca uma fixture) — nenhuma migration/
   UNIQUE novo: a proteção vive inteiramente na camada de serviço, como a
   ordem pediu. `excludeId` permite ao UPDATE ignorar o próprio padrão ao
   checar (renomear para o MESMO nome que já tinha nunca é duplicidade). */
function findDuplicateByName(patterns: AdminPatternRow[], name: string, excludeId?: string): AdminPatternRow | null {
  const normalized = normalizePatternName(name);
  return patterns.find((p) => p.id !== excludeId && normalizePatternName(p.name) === normalized) ?? null;
}

export async function createPattern(db: D1Database, adminId: string, input: RawPatternInput & { mutationId: unknown }): Promise<CreateResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };
  if (!isValidMutationId(input.mutationId)) return { ok: false, fieldErrors: { mutationId: "mutationId é obrigatório e precisa ser um UUID válido." } };
  const mutationId = input.mutationId;

  const validated = validateCreateInput(input);
  if (!validated.ok) return { ok: false, fieldErrors: validated.fieldErrors };
  const { attributes } = validated;

  // Retry-por-id ANTES do guard de nome duplicado: uma repetição legítima
  // do mesmo mutationId nunca pode ser rejeitada como "duplicata de si
  // mesma" — mesma idempotência de sempre (comparação por coreEqual).
  const existingById = await findRealPatternById(db, mutationId);
  if (existingById) {
    const fieldsForRetry: PatternCoreFields = { ...validated.fields, code: existingById.code, slug: existingById.slug };
    if (coreEqual(fieldsForRetry, existingById)) return { ok: true, changed: false, patternId: mutationId };
    return { ok: false, conflict: true };
  }

  const allPatterns = await listRealPatterns(db);
  const duplicate = findDuplicateByName(allPatterns, validated.fields.name);
  if (duplicate) return { ok: false, fieldErrors: { name: "Já existe um padrão com este nome." } };

  const existingSlugs = new Set(allPatterns.map((p) => p.slug));
  const fields: PatternCoreFields = {
    ...validated.fields,
    code: generatePatternCode(mutationId),
    slug: generatePatternSlugFromName(validated.fields.name, mutationId, existingSlugs),
  };

  try {
    await db.batch([
      buildInsertPatternStatement(db, mutationId, fields),
      ...attributeStatements(db, mutationId, attributes),
      buildAuditEventStatement(db, { id: mutationId, eventType: "admin_pattern_created", userId: adminId, metadata: { patternId: mutationId } }),
    ]);
  } catch (error) {
    // A esta altura já verificamos id/nome/slug proativamente — chegar
    // aqui só é possível por uma corrida real entre duas requisições
    // concorrentes (janela entre a leitura acima e o INSERT). Nunca uma
    // exceção crua chegando ao chamador de qualquer forma.
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
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

/* Sprint 17, seção A da ordem — UPDATE passa a ser PARCIAL: só os campos
   efetivamente enviados no corpo são alterados; qualquer campo AUSENTE
   (`undefined`, nunca enviado) preserva o valor legado existente
   intacto — inclusive `code`/`slug` (nunca reescritos por update, sempre
   herdados de `existing`) e `attributes` (só é tocado/substituído quando a
   chave `attributes` está presente no corpo; ausente = pattern_attributes
   não é sequer lido para escrita, preservando 100% do conteúdo legado). A
   UI nova só envia `{name, mainStrategy}` — o restante do contrato
   continua aceito para quem envia o payload legado completo. */
export async function updatePattern(
  db: D1Database,
  adminId: string,
  patternId: string,
  input: RawPatternInput & { mutationId: unknown; expectedVersion: unknown }
): Promise<UpdateResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };
  if (!isValidMutationId(input.mutationId)) return { ok: false, fieldErrors: { mutationId: "mutationId é obrigatório e precisa ser um UUID válido." } };
  const mutationId = input.mutationId;
  const expectedVersion = validateExpectedVersion(input.expectedVersion);
  if (!expectedVersion.ok) return { ok: false, fieldErrors: { expectedVersion: expectedVersion.error! } };

  const existing = await findRealPatternById(db, patternId);
  if (!existing) return { ok: false, notFound: true };

  const name = validateOptionalName(input.name);
  if (!name.ok) return { ok: false, fieldErrors: { name: name.error! } };
  const mainStrategy = validateOptionalMainStrategy(input.mainStrategy);
  if (!mainStrategy.ok) return { ok: false, fieldErrors: { mainStrategy: mainStrategy.error! } };
  const recognitionPhrase = validateOptionalRecognitionPhrase(input.recognitionPhrase);
  if (!recognitionPhrase.ok) return { ok: false, fieldErrors: { recognitionPhrase: recognitionPhrase.error! } };
  const description = validateOptionalPatternDescription(input.description);
  if (!description.ok) return { ok: false, fieldErrors: { description: description.error! } };
  const introductoryExample = validateOptionalIntroductoryExample(input.introductoryExample);
  if (!introductoryExample.ok) return { ok: false, fieldErrors: { introductoryExample: introductoryExample.error! } };
  const strategicSummary = validateOptionalStrategicSummary(input.strategicSummary);
  if (!strategicSummary.ok) return { ok: false, fieldErrors: { strategicSummary: strategicSummary.error! } };

  // Sprint 17.1, item 1 da ordem de auditoria — só verifica duplicidade
  // quando `name` foi REALMENTE enviado (uma renomeação de verdade);
  // manter o nome atual (campo ausente) nunca é "renomear para duplicata".
  if (name.value !== undefined) {
    const allPatterns = await listRealPatterns(db);
    const duplicate = findDuplicateByName(allPatterns, name.value, patternId);
    if (duplicate) return { ok: false, fieldErrors: { name: "Já existe um padrão com este nome." } };
  }

  const mergedFields: PatternCoreFields = {
    code: existing.code,
    slug: existing.slug,
    name: name.value ?? existing.name,
    recognitionPhrase: recognitionPhrase.value ?? existing.recognition_phrase,
    description: description.value ?? existing.description,
    mainStrategy: mainStrategy.value ?? existing.main_strategy,
    introductoryExample: introductoryExample.value ?? existing.introductory_example,
    strategicSummary: strategicSummary.value ?? existing.strategic_summary,
  };

  const attributesProvided = input.attributes !== undefined;
  let attributes: PatternAttributeLists | null = null;
  if (attributesProvided) {
    const validatedAttributes = validateAttributeLists(input.attributes);
    if (!validatedAttributes.ok) return { ok: false, fieldErrors: { attributes: validatedAttributes.error! } };
    attributes = validatedAttributes.value!;
  }

  let attributesUnchanged = true;
  if (attributesProvided) {
    const existingAttributeRows = await listAttributesForPattern(db, patternId);
    attributesUnchanged = JSON.stringify(attributesToDto(existingAttributeRows)) === JSON.stringify(attributes);
  }
  if (coreEqual(mergedFields, existing) && attributesUnchanged) return { ok: true, changed: false };

  if (existing.version !== expectedVersion.value) return { ok: false, conflict: true };

  const statements: D1PreparedStatement[] = [buildUpdatePatternCoreStatement(db, patternId, expectedVersion.value!, mergedFields)];
  if (attributesProvided) {
    statements.push(buildDeleteAttributesStatement(db, patternId), ...attributeStatements(db, patternId, attributes!));
  }
  statements.push(buildAuditEventStatement(db, { id: mutationId, eventType: "admin_pattern_updated", userId: adminId, metadata: { patternId } }));

  try {
    const result = await db.batch(statements);
    if (result[0].meta.changes !== 1) {
      const after = await findRealPatternById(db, patternId);
      if (!after) return { ok: false, notFound: true };
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

  // Sprint 17, seção A da ordem — regra editorial: publicar exige nome e
  // macete/mainStrategy não vazios; nenhum campo legado é exigido.
  if (input.action === "publish" && (!existing.name.trim() || !existing.main_strategy.trim())) {
    return { ok: false, fieldErrors: { mainStrategy: "Para publicar, preencha Padrão e Macete / Como resolver." } };
  }

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

/* Serviço do catálogo de padrões ENEM — Sprint 6 v1.0.

   Orquestra as consultas do repositório e monta os DTOs da API. Assim como
   o repositório, é 100% somente leitura: nenhuma função aqui escreve em
   nenhuma tabela (seção 4.2 da ordem).

   Regra dos três índices (seção 4.1 da ordem): as fórmulas de
   Reconhecimento, Resolução e Domínio estão PENDENTES. Um índice `NULL` no
   banco é representado explicitamente na API como
   `{ available: false, value: null }` — nunca convertido em 0, nunca
   substituído por um valor calculado por nós, em nenhuma camada.

   Campos internos que NUNCA saem daqui: `id` do padrão, `editorial_status`,
   `version`, `created_at`/`updated_at`, `user_id` e `raw_evidence_count`
   (contador bruto de evidência, reservado para a fórmula futura). O aluno
   navega por `slug`; as relações internas continuam usando o ID estável no
   banco. */

import {
  countPublishedPatterns,
  findPublishedPatternBySlug,
  findStudentPatternProgress,
  listAttributesForPatterns,
  listPublishedPatterns,
  listRelationsForPattern,
  listStudentPatternProgress,
  type PatternAttributeRow,
  type PatternListFilters,
  type PatternRow,
  type StudentPatternProgressRow,
} from "../repositories/patternsRepository";
import { findTrainableQuestionForPattern, hasAnyPublishedQuestion } from "../repositories/questionRepository";
import type { PatternAttributeType, PatternRelationType } from "../lib/patternsValidation";

/** Representação explícita de um índice indisponível. `available: false` +
 *  `value: null` é o contrato: a UI mostra "Ainda sem evidências
 *  suficientes" e nunca 0%. */
export interface PatternIndexValue {
  available: boolean;
  value: number | null;
}

export interface PatternProgressDto {
  /** true só quando existe linha de progresso deste aluno para este padrão. */
  hasProgress: boolean;
  lastPracticedAt: string | null;
  nextReviewAt: string | null;
  indices: {
    recognition: PatternIndexValue;
    resolution: PatternIndexValue;
    mastery: PatternIndexValue;
  };
}

export interface PatternSummaryDto {
  code: string;
  slug: string;
  name: string;
  recognitionPhrase: string;
  requiredContents: string[];
  tags: string[];
  isLocalFixture: boolean;
  progress: PatternProgressDto;
}

export interface PatternRelationDto {
  relationType: PatternRelationType;
  code: string;
  slug: string;
  name: string;
}

export interface PatternDetailDto extends PatternSummaryDto {
  description: string;
  mainStrategy: string;
  introductoryExample: string;
  strategicSummary: string;
  frequentClues: string[];
  recurringPhrases: string[];
  recurringVisualElements: string[];
  alternativeStrategies: string[];
  prerequisiteContents: string[];
  commonMistakes: string[];
  relations: PatternRelationDto[];
  /** Nesta fundação não existe banco de questões ligado a padrão — o valor
   *  é um zero REAL (não há nenhuma questão associada), nunca um número
   *  pedagógico inventado. */
  availableQuestionCount: number;
  /** Sprint 8 v1.1 (seção 13 da ordem) — id da questão PUBLICADA cujo
   *  padrão PRINCIPAL é este, escolhida de forma DETERMINÍSTICA (menor
   *  `code` em ordem alfabética — nenhum algoritmo pedagógico, nenhuma
   *  "adaptação"; ver `findTrainableQuestionForPattern` em
   *  questionRepository.ts). `null` quando nenhuma questão publicada está
   *  disponível — o botão "Treinar este padrão" fica desabilitado/"em
   *  preparação" nesse caso, nunca oferece um caminho quebrado. */
  trainableQuestionId: string | null;
}

export interface PatternListResultDto {
  patterns: PatternSummaryDto[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** Sprint 8 v1.1 (seção 13 da ordem) — reaproveitado pelo dashboard para o
   *  CTA "Resolver uma questão": existe pelo menos UMA questão publicada
   *  (fixture local) em todo o banco, sem nenhuma métrica/sequência
   *  inventada. */
  hasAnyTrainableQuestion: boolean;
}

function indexValue(raw: number | null | undefined): PatternIndexValue {
  return raw === null || raw === undefined ? { available: false, value: null } : { available: true, value: raw };
}

function toProgressDto(row: StudentPatternProgressRow | null): PatternProgressDto {
  return {
    hasProgress: row !== null,
    lastPracticedAt: row?.last_practiced_at ?? null,
    nextReviewAt: row?.next_review_at ?? null,
    indices: {
      recognition: indexValue(row?.recognition_index ?? null),
      resolution: indexValue(row?.resolution_index ?? null),
      mastery: indexValue(row?.mastery_index ?? null),
    },
  };
}

function attributesOfType(
  attributes: PatternAttributeRow[],
  patternId: string,
  type: PatternAttributeType
): string[] {
  return attributes
    .filter((attribute) => attribute.pattern_id === patternId && attribute.attribute_type === type)
    .map((attribute) => attribute.content);
}

function toSummaryDto(
  pattern: PatternRow,
  attributes: PatternAttributeRow[],
  progress: StudentPatternProgressRow | null
): PatternSummaryDto {
  return {
    code: pattern.code,
    slug: pattern.slug,
    name: pattern.name,
    recognitionPhrase: pattern.recognition_phrase,
    requiredContents: attributesOfType(attributes, pattern.id, "required_content"),
    tags: attributesOfType(attributes, pattern.id, "tag"),
    isLocalFixture: pattern.is_local_fixture === 1,
    progress: toProgressDto(progress),
  };
}

/** Sprint 16 v1.3 — `includeFixtures` (= `fixturesAllowed` da rota) decide
 *  se fixtures locais entram na listagem: dev local com a flag preserva o
 *  comportamento de sempre; qualquer outro caso mostra só padrões reais. */
export async function listPatterns(
  db: D1Database,
  userId: string,
  filters: PatternListFilters,
  page: number,
  pageSize: number,
  includeFixtures: boolean
): Promise<PatternListResultDto> {
  const total = await countPublishedPatterns(db, userId, filters, includeFixtures);
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  const offset = (page - 1) * pageSize;
  // Uma página além do fim é uma página legitimamente vazia (nunca 404, nunca
  // "corrigida" silenciosamente para a última) — o total informado deixa o
  // cliente saber que não há mais resultados.
  const rows = await listPublishedPatterns(db, userId, filters, pageSize, offset, includeFixtures);
  const patternIds = rows.map((row) => row.id);
  const [attributes, progressRows, hasAnyTrainableQuestion] = await Promise.all([
    listAttributesForPatterns(db, patternIds),
    listStudentPatternProgress(db, userId, patternIds),
    hasAnyPublishedQuestion(db),
  ]);
  const progressByPatternId = new Map(progressRows.map((row) => [row.pattern_id, row]));

  return {
    patterns: rows.map((row) => toSummaryDto(row, attributes, progressByPatternId.get(row.id) ?? null)),
    page,
    pageSize,
    total,
    totalPages,
    hasAnyTrainableQuestion,
  };
}

/** Ficha completa. Retorna null quando o slug não existe OU quando o padrão
 *  não está publicado — a rota traduz os dois casos no MESMO 404. */
export async function getPatternDetail(
  db: D1Database,
  userId: string,
  slug: string,
  includeFixtures: boolean
): Promise<PatternDetailDto | null> {
  const pattern = await findPublishedPatternBySlug(db, slug, includeFixtures);
  if (!pattern) return null;

  const [attributes, relations, progress, trainableQuestionId] = await Promise.all([
    listAttributesForPatterns(db, [pattern.id]),
    listRelationsForPattern(db, pattern.id, includeFixtures),
    findStudentPatternProgress(db, userId, pattern.id),
    findTrainableQuestionForPattern(db, pattern.id, includeFixtures),
  ]);

  return {
    ...toSummaryDto(pattern, attributes, progress),
    description: pattern.description,
    mainStrategy: pattern.main_strategy,
    introductoryExample: pattern.introductory_example,
    strategicSummary: pattern.strategic_summary,
    frequentClues: attributesOfType(attributes, pattern.id, "frequent_clue"),
    recurringPhrases: attributesOfType(attributes, pattern.id, "recurring_phrase"),
    recurringVisualElements: attributesOfType(attributes, pattern.id, "recurring_visual_element"),
    alternativeStrategies: attributesOfType(attributes, pattern.id, "alternative_strategy"),
    prerequisiteContents: attributesOfType(attributes, pattern.id, "prerequisite_content"),
    commonMistakes: attributesOfType(attributes, pattern.id, "common_mistake"),
    relations: relations.map((relation) => ({
      relationType: relation.relation_type,
      code: relation.code,
      slug: relation.slug,
      name: relation.name,
    })),
    availableQuestionCount: 0,
    trainableQuestionId,
  };
}

/** Progresso do aluno da sessão neste padrão. Null quando o padrão não
 *  existe/não está publicado (404 na rota). Quando o padrão existe mas o
 *  aluno nunca praticou, devolve um DTO com `hasProgress: false` e os três
 *  índices indisponíveis — sem NUNCA criar a linha. */
export async function getPatternProgress(
  db: D1Database,
  userId: string,
  slug: string,
  includeFixtures: boolean
): Promise<{ slug: string; code: string; progress: PatternProgressDto } | null> {
  const pattern = await findPublishedPatternBySlug(db, slug, includeFixtures);
  if (!pattern) return null;
  const progress = await findStudentPatternProgress(db, userId, pattern.id);
  return { slug: pattern.slug, code: pattern.code, progress: toProgressDto(progress) };
}

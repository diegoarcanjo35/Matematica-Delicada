/* Repositório do Banco de Questões — Sprint 7 v1.0.

   Consultas parametrizadas; nomes de tabela/coluna sempre literais fixos.
   Os "build*Statement" retornam D1PreparedStatement para compor um único
   db.batch() atômico no serviço — mesmo padrão de scheduleRepository.ts.

   Idempotência de histórico: TODA linha de question_history é escrita
   condicionada a `NOT EXISTS (question_id, version)` — como `version` é
   estritamente crescente e nunca reutilizada para uma mesma questão, uma
   dada versão só pode ter exatamente UM evento de histórico gravado, não
   importa quantas vezes a mesma requisição (com o mesmo expectedVersion já
   obsoleto) seja repetida. Isso evita o mesmo bug já corrigido na Sprint 5
   v1.2 (um guard baseado só em "estado atual bate com o alvo" duplicaria o
   evento numa reenvio idempotente). */

import type {
  AlternativeInput,
  QuestionCalculationType,
  QuestionDifficulty,
  QuestionDnaInput,
  QuestionEditorialStatus,
  QuestionImageInput,
  QuestionOrigin,
  QuestionPatternInput,
} from "../lib/questionsValidation";

export interface QuestionRow {
  id: string;
  code: string;
  enunciado: string;
  resolucao_comentada: string;
  conteudo: string;
  subconteudo: string;
  habilidade: string;
  competencia: string;
  dificuldade: QuestionDifficulty;
  origem: QuestionOrigin;
  prova: string | null;
  ano: number | null;
  tempo_estimado_segundos: number | null;
  tipo_calculo: QuestionCalculationType;
  necessita_calculadora: number;
  editorial_status: QuestionEditorialStatus;
  autor_id: string | null;
  revisor_id: string | null;
  titular_direitos: string | null;
  base_licenca: string | null;
  texto_atribuicao: string | null;
  fingerprint: string;
  version: number;
  is_local_fixture: number;
  created_at: string;
  updated_at: string;
}

export interface QuestionAlternativeRow {
  id: string;
  question_id: string;
  letter: string;
  text: string;
  is_correct: number;
  distractor_explanation: string | null;
  position: number;
}

export interface QuestionImageRow {
  id: string;
  question_id: string;
  asset_ref: string;
  alt_text: string;
  caption: string | null;
  position: number;
  titular_direitos: string | null;
  base_licenca: string | null;
}

export interface QuestionPatternRow {
  id: string;
  question_id: string;
  pattern_id: string;
  role: string;
}

export interface QuestionTagRow {
  id: string;
  question_id: string;
  content: string;
  position: number;
}

export interface QuestionDnaRow {
  question_id: string;
  pista: string;
  estrategia: string;
  pegadinha: string;
  conteudo_apoio: string;
  resolucao: string;
  atalho: string | null;
  aprendizado_erro: string;
}

export interface QuestionHistoryRow {
  id: string;
  question_id: string;
  user_id: string | null;
  action: string;
  from_status: string | null;
  to_status: string;
  version: number;
  metadata: string | null;
  created_at: string;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/* --------------------------------- Leitura --------------------------------- */

export async function findQuestionById(db: D1Database, id: string): Promise<QuestionRow | null> {
  const row = await db.prepare("SELECT * FROM questions WHERE id = ?").bind(id).first<QuestionRow>();
  return row ?? null;
}

export async function findQuestionByCode(db: D1Database, code: string): Promise<QuestionRow | null> {
  const row = await db.prepare("SELECT * FROM questions WHERE code = ?").bind(code).first<QuestionRow>();
  return row ?? null;
}

export async function findQuestionsByFingerprint(db: D1Database, fingerprint: string): Promise<QuestionRow[]> {
  const result = await db
    .prepare("SELECT * FROM questions WHERE fingerprint = ?")
    .bind(fingerprint)
    .all<QuestionRow>();
  return result.results ?? [];
}

export async function listAlternatives(db: D1Database, questionId: string): Promise<QuestionAlternativeRow[]> {
  const result = await db
    .prepare("SELECT * FROM question_alternatives WHERE question_id = ? ORDER BY letter ASC")
    .bind(questionId)
    .all<QuestionAlternativeRow>();
  return result.results ?? [];
}

export async function listImages(db: D1Database, questionId: string): Promise<QuestionImageRow[]> {
  const result = await db
    .prepare("SELECT * FROM question_images WHERE question_id = ? ORDER BY position ASC, id ASC")
    .bind(questionId)
    .all<QuestionImageRow>();
  return result.results ?? [];
}

export async function listPatternsForQuestion(db: D1Database, questionId: string): Promise<QuestionPatternRow[]> {
  const result = await db
    .prepare("SELECT * FROM question_patterns WHERE question_id = ? ORDER BY role ASC, id ASC")
    .bind(questionId)
    .all<QuestionPatternRow>();
  return result.results ?? [];
}

export async function listTags(db: D1Database, questionId: string): Promise<QuestionTagRow[]> {
  const result = await db
    .prepare("SELECT * FROM question_tags WHERE question_id = ? ORDER BY position ASC, id ASC")
    .bind(questionId)
    .all<QuestionTagRow>();
  return result.results ?? [];
}

export async function findDna(db: D1Database, questionId: string): Promise<QuestionDnaRow | null> {
  const row = await db
    .prepare("SELECT * FROM question_dna WHERE question_id = ?")
    .bind(questionId)
    .first<QuestionDnaRow>();
  return row ?? null;
}

export async function listHistory(db: D1Database, questionId: string): Promise<QuestionHistoryRow[]> {
  const result = await db
    .prepare("SELECT * FROM question_history WHERE question_id = ? ORDER BY created_at ASC, id ASC")
    .bind(questionId)
    .all<QuestionHistoryRow>();
  return result.results ?? [];
}

/** Sprint 7 v1.2, Correção A — busca um evento de histórico pelo próprio
 *  `id`, reaproveitado como chave de idempotência de mutação (`mutationId`)
 *  sem exigir nenhuma migration nova: `question_history.id` já é PRIMARY
 *  KEY (unicidade global garantida pelo banco), e a linha já registra
 *  ator (`user_id`), questão (`question_id`), ação (`action`) e versão
 *  resultante (`version`) — exatamente o que uma checagem de retry precisa
 *  conferir. */
export async function findHistoryById(db: D1Database, id: string): Promise<QuestionHistoryRow | null> {
  const row = await db.prepare("SELECT * FROM question_history WHERE id = ?").bind(id).first<QuestionHistoryRow>();
  return row ?? null;
}

export interface QuestionListFilters {
  search: string | null;
  status: QuestionEditorialStatus | null;
  origin: QuestionOrigin | null;
  difficulty: QuestionDifficulty | null;
  conteudo: string | null;
  autorId: string | null;
  revisorId: string | null;
  ano: number | null;
  hasImage: boolean | null;
}

function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function buildFilterClause(filters: QuestionListFilters): { sql: string; params: unknown[] } {
  const conditions: string[] = ["1 = 1"];
  const params: unknown[] = [];

  if (filters.search !== null) {
    conditions.push("(q.code LIKE ? ESCAPE '\\' OR q.enunciado LIKE ? ESCAPE '\\')");
    const term = likeTerm(filters.search);
    params.push(term, term);
  }
  if (filters.status !== null) {
    conditions.push("q.editorial_status = ?");
    params.push(filters.status);
  }
  if (filters.origin !== null) {
    conditions.push("q.origem = ?");
    params.push(filters.origin);
  }
  if (filters.difficulty !== null) {
    conditions.push("q.dificuldade = ?");
    params.push(filters.difficulty);
  }
  if (filters.conteudo !== null) {
    conditions.push("q.conteudo = ?");
    params.push(filters.conteudo);
  }
  if (filters.autorId !== null) {
    conditions.push("q.autor_id = ?");
    params.push(filters.autorId);
  }
  if (filters.revisorId !== null) {
    conditions.push("q.revisor_id = ?");
    params.push(filters.revisorId);
  }
  if (filters.ano !== null) {
    conditions.push("q.ano = ?");
    params.push(filters.ano);
  }
  if (filters.hasImage === true) {
    conditions.push("EXISTS (SELECT 1 FROM question_images qi WHERE qi.question_id = q.id)");
  } else if (filters.hasImage === false) {
    conditions.push("NOT EXISTS (SELECT 1 FROM question_images qi WHERE qi.question_id = q.id)");
  }

  return { sql: conditions.join(" AND "), params };
}

/** Ordenação sempre determinística: mais recente primeiro, desempate por
 *  code e id — nunca ordem física/de inserção. */
const ORDER_BY = "ORDER BY q.updated_at DESC, q.code ASC, q.id ASC";

export async function countQuestions(db: D1Database, filters: QuestionListFilters): Promise<number> {
  const where = buildFilterClause(filters);
  const row = await db
    .prepare(`SELECT COUNT(*) as total FROM questions q WHERE ${where.sql}`)
    .bind(...where.params)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function listQuestions(
  db: D1Database,
  filters: QuestionListFilters,
  limit: number,
  offset: number
): Promise<QuestionRow[]> {
  const where = buildFilterClause(filters);
  const result = await db
    .prepare(`SELECT q.* FROM questions q WHERE ${where.sql} ${ORDER_BY} LIMIT ? OFFSET ?`)
    .bind(...where.params, limit, offset)
    .all<QuestionRow>();
  return result.results ?? [];
}

/* ------------------------------- Escrita: criação --------------------------- */

export function buildInsertQuestionStatement(
  db: D1Database,
  params: {
    id: string;
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
    tipoCalculo: QuestionCalculationType;
    necessitaCalculadora: 0 | 1;
    autorId: string | null;
    titularDireitos: string | null;
    baseLicenca: string | null;
    textoAtribuicao: string | null;
    fingerprint: string;
    isLocalFixture: 0 | 1;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO questions
        (id, code, enunciado, resolucao_comentada, conteudo, subconteudo, habilidade, competencia,
         dificuldade, origem, prova, ano, tempo_estimado_segundos, tipo_calculo, necessita_calculadora,
         autor_id, titular_direitos, base_licenca, texto_atribuicao, fingerprint, is_local_fixture)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      params.id,
      params.code,
      params.enunciado,
      params.resolucaoComentada,
      params.conteudo,
      params.subconteudo,
      params.habilidade,
      params.competencia,
      params.dificuldade,
      params.origem,
      params.prova,
      params.ano,
      params.tempoEstimadoSegundos,
      params.tipoCalculo,
      params.necessitaCalculadora,
      params.autorId,
      params.titularDireitos,
      params.baseLicenca,
      params.textoAtribuicao,
      params.fingerprint,
      params.isLocalFixture
    );
}

export function buildInsertAlternativeStatement(
  db: D1Database,
  questionId: string,
  id: string,
  alt: AlternativeInput,
  position: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO question_alternatives (id, question_id, letter, text, is_correct, distractor_explanation, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, questionId, alt.letter, alt.text, alt.isCorrect ? 1 : 0, alt.distractorExplanation, position);
}

export function buildInsertImageStatement(
  db: D1Database,
  questionId: string,
  id: string,
  image: QuestionImageInput
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO question_images (id, question_id, asset_ref, alt_text, caption, position, titular_direitos, base_licenca)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, questionId, image.assetRef, image.altText, image.caption, image.position, image.titularDireitos, image.baseLicenca);
}

export function buildInsertPatternLinkStatement(
  db: D1Database,
  questionId: string,
  id: string,
  link: QuestionPatternInput
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO question_patterns (id, question_id, pattern_id, role) VALUES (?, ?, ?, ?)`)
    .bind(id, questionId, link.patternId, link.role);
}

export function buildInsertTagStatement(
  db: D1Database,
  questionId: string,
  id: string,
  content: string,
  position: number
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO question_tags (id, question_id, content, position) VALUES (?, ?, ?, ?)`)
    .bind(id, questionId, content, position);
}

export function buildUpsertDnaStatement(db: D1Database, questionId: string, dna: QuestionDnaInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO question_dna (question_id, pista, estrategia, pegadinha, conteudo_apoio, resolucao, atalho, aprendizado_erro, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (question_id) DO UPDATE SET
         pista = excluded.pista, estrategia = excluded.estrategia, pegadinha = excluded.pegadinha,
         conteudo_apoio = excluded.conteudo_apoio, resolucao = excluded.resolucao, atalho = excluded.atalho,
         aprendizado_erro = excluded.aprendizado_erro, updated_at = datetime('now')`
    )
    .bind(questionId, dna.pista, dna.estrategia, dna.pegadinha, dna.conteudoApoio, dna.resolucao, dna.atalho, dna.aprendizadoErro);
}

/** Histórico condicionado — só grava se, no MESMO db.batch(), a questão
 *  estiver exatamente na `versionAfter` esperada E ainda não existir um
 *  evento de histórico para esta (questão, versão) — ver nota no topo do
 *  arquivo sobre por que a versão (nunca reutilizada) é a chave de
 *  idempotência correta aqui, diferente do `to_status` usado em
 *  scheduleRepository (lá, cada to_status só é alcançado uma única vez de
 *  verdade; aqui, um mesmo to_status pode se repetir em rodadas diferentes
 *  do workflow, então a versão resultante é o identificador estável). */
/** Sprint 7 v1.3 — `guardVersion` (a versão ATUAL/pré-mutação, checada
 *  contra `questions.version` agora) e `versionAfter` (a versão RESULTANTE,
 *  gravada na linha de histórico e usada na checagem anti-duplicidade) são
 *  parâmetros DELIBERADAMENTE separados: este statement passou a rodar
 *  ANTES do UPDATE central de `questions` no mesmo lote (não depois, como
 *  nas versões anteriores) — ver worker/src/services/questionService.ts e
 *  migrations/0009_editorial_batch_invariants.sql. Guardar pela versão
 *  ATUAL (não pela resultante, que só passa a existir quando o UPDATE
 *  central rodar, momentos depois) é o que torna a reordenação possível: os
 *  dois statements (histórico e UPDATE central) avaliam a MESMA condição
 *  sobre o MESMO estado imutável-durante-a-transação, então só podem
 *  concordar (ambos passam ou ambos falham) — nunca um sem o outro, exceto
 *  pela checagem adicional `NOT EXISTS` (anti-duplicidade de retry), que é
 *  exclusiva deste statement e é exatamente o cenário que o trigger de
 *  0009 precisa capturar se falhar inesperadamente. */
export function buildConditionalHistoryStatement(
  db: D1Database,
  params: {
    id: string;
    questionId: string;
    userId: string | null;
    action: string;
    fromStatus: string | null;
    toStatus: string;
    guardVersion: number;
    versionAfter: number;
    metadata: Record<string, string | number | boolean> | null;
    /** v1.3 — quando informado, exige que `editorial_status` esteja neste
     *  conjunto no momento da checagem — SEMPRE a MESMA lista usada pelo
     *  statement "causa" que este histórico acompanha (`buildUpdateQuestionCoreStatement`'s
     *  `('draft','changes_requested')` fixo, ou `buildTransitionStatement`'s
     *  `fromStatuses` dinâmico) — nunca uma lista diferente, para que os
     *  dois guards só possam concordar. Omitido só para o histórico de
     *  CRIAÇÃO (`action: 'created'`/`'import_applied'`), onde a linha é
     *  sempre nova (não há "status errado" possível para um id inédito). */
    guardStatuses?: string[];
  }
): D1PreparedStatement {
  const statusGuard = params.guardStatuses
    ? ` AND editorial_status IN (${placeholders(params.guardStatuses.length)})`
    : "";
  return db
    .prepare(
      `INSERT INTO question_history (id, question_id, user_id, action, from_status, to_status, version, metadata)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM questions WHERE id = ? AND version = ?${statusGuard})
       AND NOT EXISTS (SELECT 1 FROM question_history WHERE question_id = ? AND version = ?)`
    )
    .bind(
      params.id,
      params.questionId,
      params.userId,
      params.action,
      params.fromStatus,
      params.toStatus,
      params.versionAfter,
      params.metadata ? JSON.stringify(params.metadata) : null,
      params.questionId,
      params.guardVersion,
      ...(params.guardStatuses ?? []),
      params.questionId,
      params.versionAfter
    );
}

/* ------------------------------- Escrita: edição ----------------------------- */

/** UPDATE do núcleo da questão, condicionado a versão exata E status
 *  elegível para edição (draft ou changes_requested — publicada nunca é
 *  editável, seção 6 da ordem). */
export function buildUpdateQuestionCoreStatement(
  db: D1Database,
  id: string,
  expectedVersion: number,
  fields: {
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
    tipoCalculo: QuestionCalculationType;
    necessitaCalculadora: 0 | 1;
    titularDireitos: string | null;
    baseLicenca: string | null;
    textoAtribuicao: string | null;
    fingerprint: string;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE questions SET
         enunciado = ?, resolucao_comentada = ?, conteudo = ?, subconteudo = ?, habilidade = ?, competencia = ?,
         dificuldade = ?, origem = ?, prova = ?, ano = ?, tempo_estimado_segundos = ?, tipo_calculo = ?,
         necessita_calculadora = ?, titular_direitos = ?, base_licenca = ?, texto_atribuicao = ?, fingerprint = ?,
         version = version + 1, updated_at = datetime('now')
       WHERE id = ? AND version = ? AND editorial_status IN ('draft', 'changes_requested')`
    )
    .bind(
      fields.enunciado,
      fields.resolucaoComentada,
      fields.conteudo,
      fields.subconteudo,
      fields.habilidade,
      fields.competencia,
      fields.dificuldade,
      fields.origem,
      fields.prova,
      fields.ano,
      fields.tempoEstimadoSegundos,
      fields.tipoCalculo,
      fields.necessitaCalculadora,
      fields.titularDireitos,
      fields.baseLicenca,
      fields.textoAtribuicao,
      fields.fingerprint,
      id,
      expectedVersion
    );
}

/** DELETE guardado pela mesma condição (id + versionAfter) — só remove as
 *  linhas-filhas se o UPDATE do núcleo, no mesmo lote, realmente tiver
 *  bumped a questão para `versionAfter`. Se o UPDATE falhou (versão
 *  desatualizada ou status não editável), este DELETE não afeta nenhuma
 *  linha — nada fica parcialmente substituído. */
/** v1.3 — inclui `editorial_status IN ('draft','changes_requested')` na
 *  MESMA condição usada por `buildUpdateQuestionCoreStatement` (nunca só a
 *  versão): como as coleções agora rodam ANTES do UPDATE central no mesmo
 *  lote (guardadas pela versão ATUAL, não pela resultante — ver
 *  questionService.ts), sem esta condição de status o guard de uma coleção
 *  poderia "passar" (versão bate) numa questão cujo status já não é mais
 *  editável enquanto o UPDATE central (que TAMBÉM checa o status) falharia
 *  — produzindo uma coleção substituída sem o núcleo/histórico
 *  correspondentes. Mantendo os guards IDÊNTICOS, eles só podem concordar. */
function guardedDeleteSql(table: string): string {
  return `DELETE FROM ${table} WHERE question_id = ? AND EXISTS (SELECT 1 FROM questions WHERE id = ? AND version = ? AND editorial_status IN ('draft', 'changes_requested'))`;
}

export function buildDeleteAlternativesStatement(db: D1Database, questionId: string, versionAfter: number): D1PreparedStatement {
  return db.prepare(guardedDeleteSql("question_alternatives")).bind(questionId, questionId, versionAfter);
}
export function buildDeleteImagesStatement(db: D1Database, questionId: string, versionAfter: number): D1PreparedStatement {
  return db.prepare(guardedDeleteSql("question_images")).bind(questionId, questionId, versionAfter);
}
export function buildDeletePatternLinksStatement(db: D1Database, questionId: string, versionAfter: number): D1PreparedStatement {
  return db.prepare(guardedDeleteSql("question_patterns")).bind(questionId, questionId, versionAfter);
}
export function buildDeleteTagsStatement(db: D1Database, questionId: string, versionAfter: number): D1PreparedStatement {
  return db.prepare(guardedDeleteSql("question_tags")).bind(questionId, questionId, versionAfter);
}

/** INSERT guardado pela mesma condição — só insere se a questão estiver
 *  exatamente em `versionAfter` (garante que o DELETE irmão, acima, também
 *  rodou de verdade nesta transação, nunca um INSERT "órfão" somado a
 *  linhas antigas não removidas). */
export function buildGuardedInsertAlternativeStatement(
  db: D1Database,
  questionId: string,
  id: string,
  alt: AlternativeInput,
  position: number,
  versionAfter: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO question_alternatives (id, question_id, letter, text, is_correct, distractor_explanation, position)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM questions WHERE id = ? AND version = ? AND editorial_status IN ('draft', 'changes_requested'))`
    )
    .bind(id, questionId, alt.letter, alt.text, alt.isCorrect ? 1 : 0, alt.distractorExplanation, position, questionId, versionAfter);
}

export function buildGuardedInsertImageStatement(
  db: D1Database,
  questionId: string,
  id: string,
  image: QuestionImageInput,
  versionAfter: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO question_images (id, question_id, asset_ref, alt_text, caption, position, titular_direitos, base_licenca)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM questions WHERE id = ? AND version = ? AND editorial_status IN ('draft', 'changes_requested'))`
    )
    .bind(
      id,
      questionId,
      image.assetRef,
      image.altText,
      image.caption,
      image.position,
      image.titularDireitos,
      image.baseLicenca,
      questionId,
      versionAfter
    );
}

export function buildGuardedInsertPatternLinkStatement(
  db: D1Database,
  questionId: string,
  id: string,
  link: QuestionPatternInput,
  versionAfter: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO question_patterns (id, question_id, pattern_id, role)
       SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM questions WHERE id = ? AND version = ? AND editorial_status IN ('draft', 'changes_requested'))`
    )
    .bind(id, questionId, link.patternId, link.role, questionId, versionAfter);
}

export function buildGuardedInsertTagStatement(
  db: D1Database,
  questionId: string,
  id: string,
  content: string,
  position: number,
  versionAfter: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO question_tags (id, question_id, content, position)
       SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM questions WHERE id = ? AND version = ? AND editorial_status IN ('draft', 'changes_requested'))`
    )
    .bind(id, questionId, content, position, questionId, versionAfter);
}

export function buildGuardedUpsertDnaStatement(
  db: D1Database,
  questionId: string,
  dna: QuestionDnaInput,
  versionAfter: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO question_dna (question_id, pista, estrategia, pegadinha, conteudo_apoio, resolucao, atalho, aprendizado_erro, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, datetime('now') WHERE EXISTS (SELECT 1 FROM questions WHERE id = ? AND version = ? AND editorial_status IN ('draft', 'changes_requested'))
       ON CONFLICT (question_id) DO UPDATE SET
         pista = excluded.pista, estrategia = excluded.estrategia, pegadinha = excluded.pegadinha,
         conteudo_apoio = excluded.conteudo_apoio, resolucao = excluded.resolucao, atalho = excluded.atalho,
         aprendizado_erro = excluded.aprendizado_erro, updated_at = datetime('now')`
    )
    .bind(questionId, dna.pista, dna.estrategia, dna.pegadinha, dna.conteudoApoio, dna.resolucao, dna.atalho, dna.aprendizadoErro, questionId, versionAfter);
}

/* --------------------------------- Transições -------------------------------- */

export function buildTransitionStatement(
  db: D1Database,
  params: {
    id: string;
    expectedVersion: number;
    fromStatuses: QuestionEditorialStatus[];
    toStatus: QuestionEditorialStatus;
    revisorId?: string | null;
  }
): D1PreparedStatement {
  const guard = `id = ? AND version = ? AND editorial_status IN (${placeholders(params.fromStatuses.length)})`;
  const revisorSet = params.revisorId !== undefined ? "revisor_id = ?," : "";
  const bindings: unknown[] = [];
  if (params.revisorId !== undefined) bindings.push(params.revisorId);
  return db
    .prepare(
      `UPDATE questions SET editorial_status = ?, ${revisorSet} version = version + 1, updated_at = datetime('now')
       WHERE ${guard}`
    )
    .bind(params.toStatus, ...bindings, params.id, params.expectedVersion, ...params.fromStatuses);
}

/* ------------------------------ Duplicidade/listas ---------------------------- */

export async function listQuestionsByIds(db: D1Database, ids: string[]): Promise<QuestionRow[]> {
  if (ids.length === 0) return [];
  const result = await db
    .prepare(`SELECT * FROM questions WHERE id IN (${placeholders(ids.length)})`)
    .bind(...ids)
    .all<QuestionRow>();
  return result.results ?? [];
}

export async function listAlternativesForQuestions(db: D1Database, questionIds: string[]): Promise<QuestionAlternativeRow[]> {
  if (questionIds.length === 0) return [];
  const result = await db
    .prepare(`SELECT * FROM question_alternatives WHERE question_id IN (${placeholders(questionIds.length)})`)
    .bind(...questionIds)
    .all<QuestionAlternativeRow>();
  return result.results ?? [];
}

export async function listImagesForQuestions(db: D1Database, questionIds: string[]): Promise<QuestionImageRow[]> {
  if (questionIds.length === 0) return [];
  const result = await db
    .prepare(`SELECT * FROM question_images WHERE question_id IN (${placeholders(questionIds.length)})`)
    .bind(...questionIds)
    .all<QuestionImageRow>();
  return result.results ?? [];
}

export async function listPatternLinksForQuestions(db: D1Database, questionIds: string[]): Promise<QuestionPatternRow[]> {
  if (questionIds.length === 0) return [];
  const result = await db
    .prepare(`SELECT * FROM question_patterns WHERE question_id IN (${placeholders(questionIds.length)})`)
    .bind(...questionIds)
    .all<QuestionPatternRow>();
  return result.results ?? [];
}

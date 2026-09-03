/* Repositório de escrita de student_pattern_progress (migrations/0007) —
   Sprint 16 v1.0 (A3, escopo mínimo).

   Deliberadamente um arquivo separado de patternsRepository.ts: aquele
   repositório declara-se 100% somente leitura por desenho (seção 4.2 da
   ordem da Sprint 6 — nenhum GET do catálogo pode criar progresso como
   efeito colateral). A escrita aqui nunca é acionada por um GET; é sempre
   um efeito colateral de uma mutação real e já existente do aluno (por ora,
   `saveRecognition` em playerService.ts — Sprint 16 seção A3).

   ESCOPO DELIBERADAMENTE MÍNIMO (ordem, seção A3): esta função só grava o
   que é FACTUAL e MECÂNICO —
     - `raw_evidence_count` incrementado em 1 por evidência real registrada;
     - `last_practiced_at` carimbado com o instante real da evidência.
   NUNCA escreve `recognition_index`/`resolution_index`/`mastery_index` nem
   `next_review_at` — essas colunas continuam NULL até uma fórmula
   pedagógica futura e explicitamente autorizada existir (mesma regra já
   documentada em patternsService.ts: um índice NULL nunca vira 0, nunca é
   substituído por um cálculo improvisado aqui). Nenhuma inferência sem
   evidência: esta função só roda quando uma evidência REAL já foi validada
   pelo chamador (nunca é chamada "preventivamente"). */
export function buildStudentPatternProgressUpsertStatement(
  db: D1Database,
  params: { userId: string; patternId: string }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO student_pattern_progress (user_id, pattern_id, last_practiced_at, raw_evidence_count, created_at, updated_at)
       VALUES (?, ?, datetime('now'), 1, datetime('now'), datetime('now'))
       ON CONFLICT (user_id, pattern_id) DO UPDATE SET
         raw_evidence_count = raw_evidence_count + 1,
         last_practiced_at = datetime('now'),
         updated_at = datetime('now')`
    )
    .bind(params.userId, params.patternId);
}

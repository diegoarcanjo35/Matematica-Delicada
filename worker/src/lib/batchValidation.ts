/* Sprint 7 v1.2, Correção B — validação de TODOS os resultados de um
   db.batch(), não só do statement "core".

   Contexto: um statement condicionado (guardado por
   `WHERE EXISTS(...) AND NOT EXISTS(...)`, o mesmo padrão usado em toda
   transição/edição atômica deste módulo) nunca LANÇA quando sua condição
   não bate — ele só afeta 0 linhas, silenciosamente. Um erro lançado por
   qualquer statement do lote já reverte a transação inteira (garantia do
   FakeD1Database e do D1 real) — isso NUNCA foi o problema. O problema é o
   caminho que NÃO lança: se o UPDATE central teve sucesso mas um statement
   condicionado que deveria ter sido a consequência direta disso (ex.: o
   INSERT de question_history, ou um INSERT de alternativa recém-substituída)
   afetar 0 linhas por algum motivo inesperado, o código nunca pode aceitar
   isso como sucesso silenciosamente.

   Esta função não assume que "tudo deve afetar exatamente 1 linha" — cada
   statement declara sua PRÓPRIA expectativa (`BatchExpectation`), porque um
   DELETE de uma coleção que já estava vazia afeta legitimamente 0 linhas. */

export type BatchExpectation = "exactlyOne" | "any";

export interface ExpectedBatchStatement {
  /** Descrição curta para a mensagem de erro — nunca conteúdo sensível. */
  label: string;
  expected: BatchExpectation;
}

export interface BatchResultLike {
  meta: { changes: number };
}

/** Lançada quando um resultado do lote não bate com a expectativa
 *  declarada — sinaliza uma inconsistência que NUNCA pode ser relatada como
 *  sucesso ao chamador. Como o `db.batch()` já foi commitado quando este
 *  erro é lançado (D1/FakeD1 não oferecem rollback pós-commit por statement
 *  individual fora de uma transação em andamento), esta é a melhor forma de
 *  "erro controlado" alcançável: a exceção propaga para
 *  worker/src/index.ts, que a converte num 500 opaco (nunca um 200/201 de
 *  sucesso) — o chamador NUNCA recebe confirmação de uma operação
 *  inconsistente. Ver docs/BANCO_QUESTOES.md, seção "Validação do lote",
 *  para a limitação documentada. */
export class BatchInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchInvariantError";
  }
}

/** Verifica cada resultado do lote contra sua expectativa declarada, na
 *  MESMA ordem. Lança `BatchInvariantError` no primeiro descompasso — nunca
 *  retorna um booleano "ok" para o chamador decidir (a violação de
 *  invariante nunca é um resultado de negócio normal, é sempre um bug a ser
 *  investigado). */
export function validateBatchResults(results: BatchResultLike[], expectations: ExpectedBatchStatement[]): void {
  if (results.length !== expectations.length) {
    throw new BatchInvariantError(
      `Lote com ${results.length} resultado(s), mas ${expectations.length} expectativa(s) declarada(s) — descompasso estrutural entre statements e expectativas.`
    );
  }
  for (let i = 0; i < expectations.length; i++) {
    const { label, expected } = expectations[i];
    const changes = results[i]?.meta.changes;
    if (expected === "exactlyOne" && changes !== 1) {
      throw new BatchInvariantError(
        `Statement "${label}" deveria ter afetado exatamente 1 linha; afetou ${changes ?? "indefinido"}.`
      );
    }
  }
}

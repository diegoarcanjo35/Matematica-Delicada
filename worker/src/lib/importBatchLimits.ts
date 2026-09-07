/* Sprint 19.1, correção 3 da ordem — teto explícito de tamanho (em bytes
   UTF-8 REAIS) do payload gravado em `question_import_batches.payload`.

   Cloudflare D1 documenta um limite de 2.000.000 bytes por linha/string
   (developers.cloudflare.com/d1/platform/limits/, confirmado nesta
   correção) — nunca podemos confiar só no limite de tamanho do arquivo de
   ENTRADA (ZIP/CSV) para garantir que o JSON serializado da prévia caiba
   numa única linha/coluna do D1; o fator de expansão de JSON (chaves
   repetidas, escaping) sobre o conteúdo bruto não é 1:1, então medimos o
   PAYLOAD em si, sempre em bytes UTF-8 reais — nunca `string.length`, que
   conta unidades UTF-16 (1 por caractere do plano básico multilíngue) e
   SUBESTIMA qualquer caractere que ocupe mais de 1 byte em UTF-8 (todo
   acento português, por exemplo, é 2 bytes em UTF-8 mas 1 em
   `string.length`) — ver `measureUtf8Bytes`. Reaproveitado pelos três
   caminhos de preview (CSV V1, CSV V2, Pacote ZIP), sempre ANTES de
   `insertImportBatch` — o erro nunca deve surgir só do D1 remoto
   rejeitando a escrita. */

const IMPORT_BATCH_PAYLOAD_MAX_BYTES = 1_800_000; // margem de ~10% abaixo do teto real de 2.000.000 bytes do D1.

export { IMPORT_BATCH_PAYLOAD_MAX_BYTES };

export function measureUtf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function isPayloadWithinBatchLimit(payloadJson: string): boolean {
  return measureUtf8Bytes(payloadJson) <= IMPORT_BATCH_PAYLOAD_MAX_BYTES;
}

/** Mensagem única e amigável — a MESMA nos três caminhos de preview, para
 *  nunca haver dois textos divergentes explicando o mesmo limite. */
export const PAYLOAD_TOO_LARGE_MESSAGE =
  "Este pacote gera uma prévia grande demais para ser processada de uma vez. Divida a importação em pacotes menores.";

/* Sprint 19.1 (correção 4) / Sprint 19.2 (seção 9 e 13 da ordem) — teto de
   QUANTIDADE de statements que um único `db.batch()` de apply vai emitir.

   Documentação oficial consultada (developers.cloudflare.com/d1/platform/
   limits/) — DUAS coisas DIFERENTES, nunca confundidas nos comentários
   deste código:
     1) "Queries per Worker invocation": 50 no plano Free, 1000 no Paid —
        é um teto de QUANTAS VEZES o Worker chama o D1 (first/all/run/
        batch) numa única invocação. Ver worker/src/lib/importValidationContext.ts
        para a eliminação do N+1 que respeita ESTE teto.
     2) statements DENTRO de um único `db.batch()`: a documentação NÃO
        apresenta um teto numérico separado para isto — só limites POR
        STATEMENT individual (100.000 bytes de SQL, 100 parâmetros
        vinculados, 2.000.000 bytes por linha/string) e um timeout de 30s
        para o batch inteiro.

   IMPORT_BATCH_MAX_D1_STATEMENTS abaixo é a resposta ao problema (2): uma
   REGRA CONSERVADORA DA APLICAÇÃO (nunca um limite oficial documentado
   pela Cloudflare) — adotada porque nosso `db.batch()` de apply pode
   conter centenas de statements (um por questão/DNA/alternativa/padrão/
   tag/history/item + um por imagem) e nem o teto de 100 questões por
   pacote isolava isso sozinho: um pacote com poucas questões mas muitas
   tags/imagens já ultrapassa esta margem. Cloudflare recomenda, como boa
   prática (não como limite rígido), processar migrações em lote "cerca de
   1000 linhas por vez" — adotamos a METADE como margem extra, já que boa
   parte dos statements deste pipeline usa subqueries de guarda (EXISTS)
   mais caras por statement do que um INSERT simples de migração.

   Compartilhado por ZIP, CSV V2 e CSV V1 (Sprint 19.2, seção 9) — o mesmo
   teto, a mesma fórmula, um único lugar. */
export const IMPORT_BATCH_MAX_D1_STATEMENTS = 500;

export interface StatementCountableRow {
  alternativas: unknown[];
  padroes: unknown[];
  tags: unknown[];
}

/** Conta EXATAMENTE o que um apply (ZIP ou CSV) vai enviar a `db.batch()`
 *  — 1 statement de marcação do lote + por linha (question, dna,
 *  alternativas, padrões, tags, history, item de importação) + 1 por
 *  imagem (`imageCount`, sempre 0 para CSV — CSV nunca cria
 *  `question_images`). Nunca uma estimativa — o MESMO cálculo usado no
 *  preview (para dar o erro cedo) e no apply (como gate final, defesa em
 *  profundidade). */
export function plannedD1StatementCountForRows(rows: StatementCountableRow[], imageCount = 0): number {
  let count = 1; // marca o lote como aplicado
  for (const row of rows) {
    count += 1; // question
    count += 1; // dna
    count += row.alternativas.length;
    count += row.padroes.length;
    count += row.tags.length;
    count += 1; // history
    count += 1; // import item
  }
  count += imageCount;
  return count;
}

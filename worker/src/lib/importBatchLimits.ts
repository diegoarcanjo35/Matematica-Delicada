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

/* Fingerprint de duplicidade do Banco de Questões — Sprint 7 v1.1/v1.2,
   Correção C. Algoritmo EXPLÍCITO, DETERMINÍSTICO e testado diretamente (ver
   worker/testing/fingerprint.test.ts) — nunca só provado indiretamente via
   comportamento de duplicidade.

   v1.2, Correção C: a v1 incluía `isCorrect` de cada alternativa no payload
   canônico — isso permitia "lavar" uma duplicata só trocando qual letra está
   marcada como correta (mesmo enunciado, mesmas alternativas, gabarito
   diferente escapava da detecção). A v2 EXCLUI o gabarito (e a explicação do
   distrator) do payload: duas questões com o mesmo enunciado e os mesmos
   TEXTOS de alternativa são a MESMA questão para fins de duplicidade,
   independente de qual alternativa cada uma marca como correta.

   Contrato (docs/BANCO_QUESTOES.md, seção "Fingerprint"):
     - calculado no Worker, nunca no banco;
     - SHA-256 em hexadecimal (crypto.subtle, mesma primitiva de
       worker/src/lib/crypto.ts — nunca um hash não criptográfico);
     - a partir de uma representação canônica VERSIONADA (JSON.stringify de
       um objeto com chaves e ordem fixas — nunca concatenação ambígua de
       string);
     - inclui, no mínimo, o enunciado e os TEXTOS das cinco alternativas
       A-E, sempre reordenadas por letra — nunca a ordem em que o cliente as
       enviou;
     - EXCLUI explicitamente: indicação de correta (`isCorrect`), explicação
       do distrator, código editorial, ID, status editorial, autor, revisor
       e datas — nenhum desses campos entra no payload canônico;
     - produz o MESMO resultado seja a questão criada pelo formulário
       unitário ou pela importação CSV, porque os dois caminhos chamam esta
       MESMA função com os MESMOS tipos de entrada (nunca duas
       implementações paralelas).

   Uma mudança futura de algoritmo exige uma nova constante de versão (ex.:
   "question-fingerprint-v3") e uma estratégia de migration/reindexação
   explícita — nunca uma alteração silenciosa do texto canônico sob a MESMA
   versão, o que tornaria fingerprints antigos e novos incomparáveis sem
   aviso. A troca de v1 para v2 NESTA correção não exige essa reindexação:
   a Sprint 7 ainda não foi mesclada em `main` nem tocou D1 remoto, então não
   existe fingerprint v1 "real" em produção para reconciliar — só as
   fixtures/dados técnicos locais deste branch, recalculados nesta mesma
   correção. */

import { sha256Hex } from "./crypto";
import type { QuestionAlternativeLetter } from "./questionsValidation";

/** Versão do algoritmo — sempre o primeiro campo do payload canônico.
 *  Nunca reaproveitada para uma mudança de regra: uma mudança de algoritmo
 *  troca esta constante. v1.2, Correção C: bump de v1 para v2 (payload
 *  mudou — gabarito excluído), nunca um "v1" com regras diferentes. */
export const QUESTION_FINGERPRINT_VERSION = "question-fingerprint-v2";

export interface FingerprintAlternativeInput {
  letter: QuestionAlternativeLetter | string;
  text: string;
  /** Aceito na assinatura por compatibilidade com o formato já usado nos
   *  dois call sites (AlternativeInput completo) — mas NUNCA entra no
   *  payload canônico a partir da v2 (Correção C). */
  isCorrect: boolean;
}

/** Normalização de texto para fins de fingerprint — nunca para exibição.
 *  Passos, NESTA ORDEM (documentados em docs/BANCO_QUESTOES.md):
 *    1) Unicode NFC — formas visualmente idênticas (ex.: "á" precomposto vs.
 *       "a" + acento combinante) produzem o MESMO fingerprint;
 *    2) CRLF/CR -> LF — quebra de linha do Windows vs. Unix não muda o
 *       fingerprint, mas a quebra em si (\n) É preservada — ela pode ser
 *       semanticamente relevante (separar etapas de um enunciado);
 *    3) trim() das bordas — espaço externo nunca é conteúdo;
 *    4) colapso de sequências de espaço/tab HORIZONTAL em um único espaço —
 *       nunca toca `\n`, nunca remove/altera `-`, `+`, `=`, expoentes (^),
 *       frações (/), pontuação ou qualquer caractere que não seja espaço/tab. */
export function canonicalizeFingerprintText(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .trim()
    .replace(/[ \t]+/g, " ");
}

/** Monta o payload canônico — SEMPRE o mesmo formato de objeto (mesmas
 *  chaves, mesma ordem de inserção), alternativas SEMPRE reordenadas por
 *  letra (nunca pela ordem de chegada). `JSON.stringify` de um objeto
 *  literal construído com uma ordem de chaves fixa é determinístico em
 *  JavaScript (a ordem de serialização segue a ordem de inserção para
 *  chaves string). */
export function buildCanonicalFingerprintPayload(
  enunciado: string,
  alternatives: FingerprintAlternativeInput[]
): { v: string; enunciado: string; alternativas: Array<{ letter: string; text: string }> } {
  const sorted = [...alternatives].sort((a, b) => a.letter.localeCompare(b.letter));
  return {
    v: QUESTION_FINGERPRINT_VERSION,
    enunciado: canonicalizeFingerprintText(enunciado),
    // v1.2, Correção C: SEM `correta`/isCorrect e SEM explicação do
    // distrator — só letra + texto. Trocar o gabarito ou a explicação do
    // distrator NUNCA muda o fingerprint.
    alternativas: sorted.map((alt) => ({
      letter: alt.letter,
      text: canonicalizeFingerprintText(alt.text),
    })),
  };
}

/** Ponto único de cálculo — chamado por worker/src/services/questionService.ts
 *  (criação/edição unitária) E worker/src/services/questionImportService.ts
 *  (importação CSV). NUNCA há uma segunda implementação: os dois caminhos
 *  produzem o mesmo fingerprint para o mesmo conteúdo porque chamam esta
 *  MESMA função. */
export async function computeQuestionFingerprint(
  enunciado: string,
  alternatives: FingerprintAlternativeInput[]
): Promise<string> {
  const payload = buildCanonicalFingerprintPayload(enunciado, alternatives);
  return sha256Hex(JSON.stringify(payload));
}

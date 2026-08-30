/* Fingerprint de duplicidade do Banco de Questões — Sprint 7 v1.1, Correção
   C. Algoritmo EXPLÍCITO, DETERMINÍSTICO e testado diretamente (ver
   worker/testing/fingerprint.test.ts) — nunca só provado indiretamente via
   comportamento de duplicidade.

   Contrato (docs/BANCO_QUESTOES.md, seção "Fingerprint"):
     - calculado no Worker, nunca no banco;
     - SHA-256 em hexadecimal (crypto.subtle, mesma primitiva de
       worker/src/lib/crypto.ts — nunca um hash não criptográfico);
     - a partir de uma representação canônica VERSIONADA (JSON.stringify de
       um objeto com chaves e ordem fixas — nunca concatenação ambígua de
       string);
     - inclui, no mínimo, o enunciado e as cinco alternativas (texto +
       indicação de correta), sempre reordenadas por letra A-E — nunca a
       ordem em que o cliente as enviou;
     - independente de código editorial, ID, status editorial, autor,
       revisor e datas — nenhum desses campos entra no payload canônico;
     - produz o MESMO resultado seja a questão criada pelo formulário
       unitário ou pela importação CSV, porque os dois caminhos chamam esta
       MESMA função com os MESMOS tipos de entrada (nunca duas
       implementações paralelas).

   Uma mudança futura de algoritmo exige uma nova constante de versão (ex.:
   "question-fingerprint-v2") e uma estratégia de migration/reindexação
   explícita — nunca uma alteração silenciosa do texto canônico sob a MESMA
   versão, o que tornaria fingerprints antigos e novos incomparáveis sem
   aviso. */

import { sha256Hex } from "./crypto";
import type { QuestionAlternativeLetter } from "./questionsValidation";

/** Versão do algoritmo — sempre o primeiro campo do payload canônico.
 *  Nunca reaproveitada para uma mudança de regra: uma mudança de algoritmo
 *  troca esta constante. */
export const QUESTION_FINGERPRINT_VERSION = "question-fingerprint-v1";

export interface FingerprintAlternativeInput {
  letter: QuestionAlternativeLetter | string;
  text: string;
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
): { v: string; enunciado: string; alternativas: Array<{ letter: string; text: string; correta: boolean }> } {
  const sorted = [...alternatives].sort((a, b) => a.letter.localeCompare(b.letter));
  return {
    v: QUESTION_FINGERPRINT_VERSION,
    enunciado: canonicalizeFingerprintText(enunciado),
    alternativas: sorted.map((alt) => ({
      letter: alt.letter,
      text: canonicalizeFingerprintText(alt.text),
      correta: alt.isCorrect,
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

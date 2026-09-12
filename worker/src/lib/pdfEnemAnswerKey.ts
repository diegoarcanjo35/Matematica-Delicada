/* Parser do gabarito oficial — Sprint 22, seção 5/11 da ordem.

   Produz EXCLUSIVAMENTE um Map<número, letra> a partir do PDF do
   gabarito — `correctAlternative` NUNCA nasce de outro lugar (nunca da
   resolução, nunca do texto da prova, nunca de heurística/modelo). Este é
   o ÚNICO ponto do pipeline inteiro que pode preencher uma resposta
   correta.

   Layout aceito (linha a linha, já extraída por `pdfEnemExtractor.ts`):
   qualquer linha que contenha um número de questão seguido, na mesma
   linha, por uma letra A-E isolada — cobre tanto uma tabela "Questão |
   Resposta" (colunas viram a mesma linha de texto lida em ordem X) quanto
   o formato compacto "136 C". Nunca aceita letras coladas a outro texto
   (ex.: "Caderno C" não deve virar um gabarito espúrio) — a letra precisa
   estar isolada por espaço/borda de linha. */

const ANSWER_KEY_LINE_RE = /(?:^|\s)0*([1-9]\d{0,2})(?:ª|º)?\s*[-:.)]?\s+([A-E])(?:\s|$)/;

export type AnswerLetter = "A" | "B" | "C" | "D" | "E";

export interface AnswerKeyParseResult {
  ok: boolean;
  answers?: Map<number, AnswerLetter>;
  errors: string[];
}

export function parseAnswerKeyLines(lines: string[]): AnswerKeyParseResult {
  const answers = new Map<number, AnswerLetter>();
  const errors: string[] = [];
  const duplicates = new Set<number>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(ANSWER_KEY_LINE_RE);
    if (!match) continue;
    const number = Number(match[1]);
    const letter = match[2] as AnswerLetter;
    if (answers.has(number)) {
      if (answers.get(number) !== letter) {
        errors.push(`Questão ${number} aparece mais de uma vez no gabarito com respostas diferentes (${answers.get(number)} e ${letter}).`);
      } else {
        errors.push(`Questão ${number} aparece duplicada no gabarito (mesma resposta, ${letter}) — cada questão deve aparecer uma única vez.`);
      }
      duplicates.add(number);
      continue;
    }
    answers.set(number, letter);
  }

  for (const number of duplicates) answers.delete(number);

  if (answers.size === 0) errors.push("Nenhuma resposta reconhecida no PDF do gabarito.");

  return { ok: errors.length === 0, answers, errors };
}

export function parseAnswerKeyFromPageLines(pagesLines: string[][]): AnswerKeyParseResult {
  return parseAnswerKeyLines(pagesLines.flat());
}

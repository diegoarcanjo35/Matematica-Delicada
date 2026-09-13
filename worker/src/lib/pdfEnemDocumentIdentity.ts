/* Identidade DOCUMENTAL detectada no texto do PDF — Sprint 22.1, seções
   2/3/4 da ordem.

   Extração CONSERVADORA, nunca um parser universal: procura padrões
   ESPECÍFICOS do formato real do ENEM/INEP (confirmado contra o PDF
   oficial 2019 — Caderno 7 Azul, 2º dia — usado no smoke desta sprint):

     - Prova: cabeçalho de rodapé repetido em toda página de questão,
       formato "<ÁREA> - <N>º dia | Caderno <NUM> - <COR> - Página <N>"
       (ex.: "CN - 2º dia | Caderno 7 - AZUL - Página 2").
     - Gabarito: uma linha "<N>º DIA - CADERNO <NUM>" e, separadamente
       (layout de duas colunas — a segunda metade da mesma linha visual
       vira uma linha própria após o agrupamento por coluna), uma linha
       "<COR> Gabarito <ANO>" (ex.: "Azul Gabarito 2019").

   TODO campo é opcional — nunca inventado. Um campo não encontrado fica
   `undefined`, nunca um palpite. Documentos de formato diferente (outra
   aplicação/ano do ENEM, ou outro exame) podem não bater com nenhum
   destes padrões — nesse caso a função devolve `{}` e a UI mostra
   "Identidade não pôde ser confirmada automaticamente", nunca finge ter
   validado. */

import type { PdfPageText } from "./pdfEnemExtractor";
import type { ExamIdentity } from "./pdfEnemExamIdentity";
import { isOcrConfidentEnoughForIdentity } from "./pdfEnemOcrModel";

export interface DetectedDocumentIdentity {
  year?: number;
  day?: number;
  bookletNumber?: number;
  color?: string;
  application?: string;
  /** Sprint 24, seção 8 da ordem — `true` quando QUALQUER campo acima foi
   *  lido de uma linha de origem OCR com confiança "low". Identidade
   *  documental detectada por OCR é sempre menos confiável que texto
   *  nativo — este PDF nunca pode, sozinho, produzir
   *  `confirmedAutomatically=true` (ver `checkDocumentIdentity`). */
  lowConfidenceOcrSource?: boolean;
}

const KNOWN_BOOKLET_COLORS = ["AZUL", "AMARELO", "ROSA", "CINZA", "BRANCO", "VERDE", "LARANJA"];

/* "[ºo°]" — tolera tanto o indicador ordinal real ("º") quanto "o" simples
   (usado nas fixtures técnicas ASCII dos testes, já que "º" em bytes
   UTF-8 dentro de uma string PDF de fonte padrão WinAnsi renderizaria
   garbled — nunca um problema real com o PDF oficial, que já vem
   corretamente codificado pelo produtor).

   Hotfix pós-Sprint 24.1 — investigação real contra o PDF oficial ENEM
   2024 (2º dia, Caderno 5, Amarelo) encontrou DOIS formatos de identidade
   genuinamente diferentes do padrão 2019 usado para calibrar os regexes
   originais (nunca um problema do parser, um problema real de o layout do
   produtor ter mudado entre edições):
     - Rodapé da PROVA: 2019 era uma linha só, "CN - 2º dia | Caderno 7 -
       AZUL - Página 2"; 2024 é "º DIA • CADERNO 5 • AMARELO •" — SEM o
       dígito do dia (aparentemente perdido/não capturável no texto nativo
       desta edição) e usando "•" em vez de "|"/"-" como separador, sem o
       sufixo "- Página N".
     - Cabeçalho do GABARITO: 2019 vinha em DUAS linhas combinadas ("2º DIA
       - CADERNO 7" e "AZUL Gabarito 2019"); 2024 vem espalhado em CINCO
       linhas separadas ("º", "2 dia", "CADERNO 5", "Amarelo", "Gabarito
       2024") — a mesma informação, só que cada palavra/token do bloco
       vira sua própria linha.
   Correção estrutural (nunca amarrada a "2024"): os regexes abaixo toleram
   o dígito do dia ausente, aceitam "|"/"-"/"•" como separador
   indiferentemente, e (só para o gabarito) são aplicados contra o texto de
   TODAS as linhas da página JUNTAS (nunca uma linha isolada) — assim
   funcionam tanto quando a informação está numa linha só quanto quando
   está espalhada em várias linhas adjacentes, em qualquer ordem futura de
   quebra de linha que o produtor venha a usar. */
const EXAM_FOOTER_RE = /(\d)?\s*[ºo°]\s*dia\s*[|•-]\s*Caderno\s*(\d+)\s*[•-]\s*([A-ZÀ-ÖØ-Ý]+)/i;
const KEY_DAY_BOOKLET_RE = /[ºo°]?\s*(\d)\s*[ºo°]?\s*dia\s*[-–•]?\s*Caderno\s*(\d+)/i;
const KEY_COLOR_YEAR_RE = /(AZUL|AMARELO|ROSA|CINZA|BRANCO|VERDE|LARANJA)\s+GABARITO\s+(\d{4})/i;

function normalizeColor(raw: string): string | undefined {
  const upper = raw.toUpperCase();
  return KNOWN_BOOKLET_COLORS.includes(upper) ? upper : undefined;
}

/** Procura o cabeçalho repetido de rodapé/cabeçalho da PROVA em qualquer
 *  página — o mesmo padrão se repete em toda página de questão, então
 *  basta a PRIMEIRA ocorrência confiável. */
function isLowConfidenceOcrLine(line: { source?: "native" | "ocr"; confidencePercent?: number }): boolean {
  return line.source === "ocr" && !isOcrConfidentEnoughForIdentity(line.confidencePercent ?? 0);
}

export function detectExamDocumentIdentity(pages: PdfPageText[]): DetectedDocumentIdentity {
  for (const page of pages) {
    for (const line of page.lines) {
      const match = line.text.match(EXAM_FOOTER_RE);
      if (!match) continue;
      const color = normalizeColor(match[3]);
      // Seção 5 do hotfix — o dígito do dia pode estar ausente nesta
      // edição (grupo de captura opcional); `day` fica `undefined` nesse
      // caso, nunca inventado (mesma regra de "campo opcional" de sempre).
      const detected: DetectedDocumentIdentity = { bookletNumber: Number(match[2]), color };
      if (match[1] !== undefined) detected.day = Number(match[1]);
      if (isLowConfidenceOcrLine(line)) detected.lowConfidenceOcrSource = true;
      return detected;
    }
  }
  return {};
}

/** Procura, em qualquer página do GABARITO, a linha "N DIA - CADERNO M"
 *  e, separadamente, a linha "<COR> Gabarito <ANO>" — podem aparecer em
 *  posições distintas da lista de linhas (colunas diferentes da mesma
 *  página), nunca assumidas adjacentes. */
/** Hotfix pós-Sprint 24.1 — o bloco de identidade do gabarito pode vir
 *  como uma linha combinada ("2º DIA - CADERNO 7", edição 2019) OU
 *  espalhado em várias linhas adjacentes, uma palavra/token por linha
 *  ("º" / "2 dia" / "CADERNO 5", edição 2024) — nunca sabemos de antemão
 *  qual formato um caderno futuro vai usar. Em vez de casar linha por
 *  linha, junta TODO o texto do documento (ordem de leitura já correta,
 *  nunca reordenada) numa única string com espaço entre linhas — os dois
 *  formatos viram uma sequência contígua de tokens nessa string conjunta,
 *  então o MESMO regex tolerante casa em ambos os casos. */
export function detectAnswerKeyDocumentIdentity(pages: PdfPageText[]): DetectedDocumentIdentity {
  const result: DetectedDocumentIdentity = {};
  const allLines = pages.flatMap((page) => page.lines);
  const joinedText = allLines.map((l) => l.text).join(" ");
  const hasLowConfidenceOcrLine = allLines.some((l) => isLowConfidenceOcrLine(l));

  const dayMatch = joinedText.match(KEY_DAY_BOOKLET_RE);
  if (dayMatch) {
    result.day = Number(dayMatch[1]);
    result.bookletNumber = Number(dayMatch[2]);
  }
  const colorMatch = joinedText.match(KEY_COLOR_YEAR_RE);
  if (colorMatch) {
    result.color = normalizeColor(colorMatch[1]);
    result.year = Number(colorMatch[2]);
  }
  if ((dayMatch || colorMatch) && hasLowConfidenceOcrLine) result.lowConfidenceOcrSource = true;
  return result;
}

export interface DocumentIdentityCheckResult {
  /** `false` = divergência REAL encontrada entre prova/gabarito, ou entre
   *  um dos dois e o que o editor confirmou — bloqueia o apply (seção 3
   *  da ordem: fail-closed). */
  ok: boolean;
  /** `true` SOMENTE quando dia+caderno+cor foram detectados nos DOIS
   *  documentos E coincidem entre si — nunca "true" por falta de sinal
   *  (ausência de detecção nunca é tratada como confirmação). */
  confirmedAutomatically: boolean;
  /** Mensagens humanas — tanto divergências bloqueantes quanto o aviso
   *  neutro "não pôde ser confirmado automaticamente" quando aplicável. */
  messages: string[];
  examDetected: DetectedDocumentIdentity;
  answerKeyDetected: DetectedDocumentIdentity;
}

function editorTextMentions(editorText: string, value: string | number | undefined): boolean {
  if (value === undefined) return true; // nada detectado para comparar — não é uma divergência.
  return editorText.toUpperCase().includes(String(value).toUpperCase());
}

/** Seção 3 da ordem — comparação em três vias: prova × gabarito × editor.
 *  Qualquer campo detectado nos DOIS PDFs que DIVIRJA entre si bloqueia
 *  (nunca importa o que o editor digitou). Um campo detectado em só um
 *  dos PDFs mas ausente no texto livre que o editor confirmou (campo
 *  "Caderno/cor") também bloqueia — sinal de que o editor pode ter
 *  confirmado a identidade errada. Campo não detectado em NENHUM dos
 *  dois lados nunca bloqueia sozinho (não inventa problema onde não há
 *  sinal).
 *
 *  Sprint 22.2 — recebe a `ExamIdentity` CONFIRMADA inteira (não mais só
 *  o texto livre de "Caderno/cor"): bug real encontrado — `year` já era
 *  detectado no gabarito (`detectAnswerKeyDocumentIdentity`) mas nunca
 *  comparado contra nada, então "prova 2019 / gabarito 2020 / editor
 *  confirmando 2019" passava batendo em dia/caderno/cor. Agora o ano
 *  detectado em QUALQUER um dos dois PDFs é comparado tanto contra o ano
 *  CONFIRMADO pelo editor quanto contra o ano detectado no OUTRO
 *  documento — mesma disciplina fail-closed dos demais campos. */
export function checkDocumentIdentity(
  examDetected: DetectedDocumentIdentity,
  answerKeyDetected: DetectedDocumentIdentity,
  confirmedIdentity: ExamIdentity
): DocumentIdentityCheckResult {
  const messages: string[] = [];
  const editorBookletText = confirmedIdentity.booklet;

  if (examDetected.day !== undefined && answerKeyDetected.day !== undefined && examDetected.day !== answerKeyDetected.day) {
    messages.push(`Dia divergente entre os PDFs: a prova indica ${examDetected.day}º dia, o gabarito indica ${answerKeyDetected.day}º dia.`);
  }
  if (
    examDetected.bookletNumber !== undefined &&
    answerKeyDetected.bookletNumber !== undefined &&
    examDetected.bookletNumber !== answerKeyDetected.bookletNumber
  ) {
    messages.push(`Caderno divergente entre os PDFs: a prova indica Caderno ${examDetected.bookletNumber}, o gabarito indica Caderno ${answerKeyDetected.bookletNumber}.`);
  }
  if (examDetected.color && answerKeyDetected.color && examDetected.color !== answerKeyDetected.color) {
    messages.push(`Cor de caderno divergente entre os PDFs: a prova indica ${examDetected.color}, o gabarito indica ${answerKeyDetected.color}.`);
  }
  if (examDetected.year !== undefined && answerKeyDetected.year !== undefined && examDetected.year !== answerKeyDetected.year) {
    messages.push(`Ano divergente entre os PDFs: a prova indica ${examDetected.year}, o gabarito indica ${answerKeyDetected.year}.`);
  }
  if (answerKeyDetected.year !== undefined && answerKeyDetected.year !== confirmedIdentity.year) {
    messages.push(`O ano detectado no GABARITO (${answerKeyDetected.year}) diverge do ano confirmado (${confirmedIdentity.year}).`);
  }
  if (examDetected.year !== undefined && examDetected.year !== confirmedIdentity.year) {
    messages.push(`O ano detectado na PROVA (${examDetected.year}) diverge do ano confirmado (${confirmedIdentity.year}).`);
  }

  if (!editorTextMentions(editorBookletText, examDetected.bookletNumber)) {
    messages.push(`O número de caderno detectado na PROVA (${examDetected.bookletNumber}) não aparece no campo "Caderno/cor" confirmado.`);
  }
  if (!editorTextMentions(editorBookletText, examDetected.color)) {
    messages.push(`A cor de caderno detectada na PROVA (${examDetected.color}) não aparece no campo "Caderno/cor" confirmado.`);
  }
  if (!editorTextMentions(editorBookletText, answerKeyDetected.bookletNumber)) {
    messages.push(`O número de caderno detectado no GABARITO (${answerKeyDetected.bookletNumber}) não aparece no campo "Caderno/cor" confirmado.`);
  }
  if (!editorTextMentions(editorBookletText, answerKeyDetected.color)) {
    messages.push(`A cor de caderno detectada no GABARITO (${answerKeyDetected.color}) não aparece no campo "Caderno/cor" confirmado.`);
  }

  // Sprint 24, seção 8 da ordem — identidade OCR de confiança baixa nunca
  // pode, sozinha, produzir `confirmedAutomatically=true`, mesmo que os
  // campos coincidam entre os dois PDFs — o editor precisa confirmar
  // manualmente. Nunca uma divergência (não bloqueia o apply), só impede a
  // confirmação automática silenciosa.
  const hasLowConfidenceOcrIdentity = !!examDetected.lowConfidenceOcrSource || !!answerKeyDetected.lowConfidenceOcrSource;

  const confirmedAutomatically =
    !hasLowConfidenceOcrIdentity &&
    examDetected.day !== undefined &&
    answerKeyDetected.day !== undefined &&
    examDetected.day === answerKeyDetected.day &&
    examDetected.bookletNumber !== undefined &&
    answerKeyDetected.bookletNumber !== undefined &&
    examDetected.bookletNumber === answerKeyDetected.bookletNumber &&
    !!examDetected.color &&
    !!answerKeyDetected.color &&
    examDetected.color === answerKeyDetected.color &&
    messages.length === 0;

  if (hasLowConfidenceOcrIdentity && messages.length === 0) {
    messages.push("Identidade detectada via OCR com confiança baixa — confirme manualmente.");
  } else if (!confirmedAutomatically && messages.length === 0) {
    messages.push("Identidade não pôde ser confirmada automaticamente neste arquivo.");
  }

  return { ok: messages.every((m) => !isDivergenceMessage(m)), confirmedAutomatically, messages, examDetected, answerKeyDetected };
}

/** Distingue a mensagem neutra ("não pôde ser confirmado") das
 *  mensagens de DIVERGÊNCIA real (que bloqueiam) — nunca a mesma coisa. */
function isDivergenceMessage(message: string): boolean {
  return !message.startsWith("Identidade não pôde ser confirmada automaticamente") && !message.startsWith("Identidade detectada via OCR");
}

/* Modelo compartilhado de OCR — Sprint 24, seções 3/4/6/18/19 da ordem.

   OCR É UMA FONTE DE TEXTO INCERTA (princípio central da ordem) — por isso
   todo texto de origem OCR carrega, sempre, sua `confidencePercent` (0-100,
   quando o engine informar) e nunca é indistinguível de texto nativo no
   modelo de dados. `classifyOcrConfidence` traduz o número bruto do engine
   em UMA de três faixas (nunca um único limiar global — seção 6 da ordem):
   itens estruturais críticos (número da questão, letra de alternativa,
   letra do gabarito) só passam com confiança >= `OCR_CONFIDENCE_MEDIUM`;
   abaixo disso, o item nunca é aceito como fato — vira `needs_review` (ou,
   no caso do gabarito, `correctAlternative=null`, nunca inferido). */

export type OcrConfidenceBand = "high" | "medium" | "low";

/** Confiança bruta do engine (0-100) >= HIGH → banda "high"; >= MEDIUM →
 *  "medium"; abaixo → "low". Calibrado conservador (nunca otimista): um
 *  elemento estrutural crítico só é aceito automaticamente em "high"/
 *  "medium" — "low" sempre força revisão humana (seção 6/7 da ordem). */
export const OCR_CONFIDENCE_HIGH = 85;
export const OCR_CONFIDENCE_MEDIUM = 60;

export function classifyOcrConfidence(confidencePercent: number): OcrConfidenceBand {
  if (confidencePercent >= OCR_CONFIDENCE_HIGH) return "high";
  if (confidencePercent >= OCR_CONFIDENCE_MEDIUM) return "medium";
  return "low";
}

/** Seção 7 da ordem — regra absoluta do gabarito: uma letra OCR só é aceita
 *  como resposta correta em confiança >= MEDIUM. Abaixo disso,
 *  `correctAlternative` fica `null` para aquela questão — nunca inferido,
 *  nunca "corrigido" por IA, nunca herdado de outra fonte. */
export function isOcrConfidentEnoughForAnswerKey(confidencePercent: number): boolean {
  return classifyOcrConfidence(confidencePercent) !== "low";
}

/** Seção 6 da ordem — mesmo limiar aplicado a elementos estruturais
 *  críticos da PROVA (número da questão, letra de alternativa): confiança
 *  "low" nunca é aceita como fato — gera aviso, que por sua vez already
 *  força `needs_review` no restante do pipeline (warnings.length>0). */
export function isOcrConfidentEnoughForStructural(confidencePercent: number): boolean {
  return classifyOcrConfidence(confidencePercent) !== "low";
}

/** Seção 8 da ordem — identidade documental (ano/dia/caderno/cor) detectada
 *  via OCR só pode confirmar automaticamente em confiança >= MEDIUM. */
export function isOcrConfidentEnoughForIdentity(confidencePercent: number): boolean {
  return classifyOcrConfidence(confidencePercent) !== "low";
}

/** Estado por página — seção 2 da ordem. `text_layer_good`/`partial`/
 *  `needs_ocr` são calculados SEM OCR (só a camada nativa); depois que o
 *  cliente devolve OCR para as páginas marcadas, o resultado final por
 *  página vira `ocr_completed` (fundido com sucesso) ou permanece incerto o
 *  bastante para virar aviso (nunca um estado "ocr_needs_review" separado
 *  no modelo — o aviso already é o mecanismo de sinalização usado em todo o
 *  resto do pipeline, seção 9 da ordem: "não criar importador paralelo"). */
export type PageTextQualityState = "text_layer_good" | "text_layer_partial" | "needs_ocr";

export interface PageQualityDiagnostic {
  pageNumber: number;
  state: PageTextQualityState;
  nonWhitespaceChars: number;
  hasVisualContent: boolean;
  /** `true` quando OCR já foi fornecido e fundido para esta página nesta
   *  chamada (seção 4/9 da ordem — combinação nativo+OCR por página). */
  ocrApplied: boolean;
}

/** Uma linha de texto já reconhecida por OCR, no MESMO espaço de
 *  coordenadas PDF nativo (Y cresce para cima, como `PdfTextLine.y`) — o
 *  cliente é responsável por converter as coordenadas de pixel do canvas de
 *  volta para o espaço de página original antes de enviar (mesma escala
 *  usada para renderizar, sempre reversível). */
export interface OcrLineInput {
  x: number;
  y: number;
  text: string;
  confidencePercent: number;
}

export interface OcrPageInput {
  pageNumber: number;
  lines: OcrLineInput[];
}

/* Seção 19 da ordem — limites obrigatórios, fail-closed, nunca ilimitados.
   Aplicados tanto pelo cliente (antes de renderizar/enviar) quanto
   revalidados aqui no worker (nunca confia só no lado do cliente). */
export const MAX_OCR_PAGES_PER_BATCH = 40; // ENEM tem no máximo ~90 páginas por caderno; nunca todas escaneadas de uma vez sem revisão — teto generoso mas finito.
export const MAX_OCR_LINES_PER_PAGE = 400; // proteção contra um engine hostil/bug devolvendo milhares de "linhas" por página.
export const MAX_OCR_TEXT_LENGTH_PER_LINE = 2000; // uma linha de texto real de prova nunca é tão longa; corta abuso.

/** Seção 24/11 da ordem — heurística de possível PERDA de símbolo
 *  matemático no texto OCR. Nunca "corrige" nada — só marca suspeita para
 *  revisão humana. Puramente estrutural (regex sobre padrões conhecidos de
 *  erro comum de OCR), nunca uma lista de palavras específicas do PDF. */
const SUSPECT_PATTERNS: Array<{ re: RegExp; description: string }> = [
  { re: /\d\s*[xX]\s*10\s+\d/, description: "possível notação científica com expoente perdido (ex.: \"2x10 3\")" },
  { re: /\braiz\b(?!\s*quadrada)/i, description: "menção a \"raiz\" sem o símbolo √ correspondente — possível perda de símbolo" },
  { re: /\d\s*\/\s*$/, description: "fração aparentemente cortada no fim da linha" },
  { re: /^\s*\/\s*\d/, description: "fração aparentemente cortada no início da linha" },
  { re: /\d{1,3}\s{2,}\d{1,3}(?:\s{2,}\d{1,3})+/, description: "sequência de números bem espaçados — possível tabela ou expoente/subscrito deslocado" },
];

export function detectSuspiciousMathText(text: string): string[] {
  const warnings: string[] = [];
  for (const { re, description } of SUSPECT_PATTERNS) {
    if (re.test(text)) warnings.push(description);
  }
  return warnings;
}

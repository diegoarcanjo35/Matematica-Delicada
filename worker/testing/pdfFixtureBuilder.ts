/* Construtor de PDF técnico MÍNIMO para testes — Sprint 22.

   Gera um PDF válido o suficiente para o pdf.js (via fallback de
   recuperação de xref, o mesmo caminho provado no feasibility spike desta
   sprint) extrair texto por posição. NUNCA usa nenhuma prova oficial real
   — só texto ASCII técnico, sem acento (evita qualquer questão de
   encoding no fluxo mínimo de string PDF sem CMap customizado). "QUESTAO"
   sem acento aqui casa deliberadamente com a segunda alternativa do
   regex de cabeçalho de questão (aceita "QUESTÃO" OU "QUESTAO").

   Nunca reproduz uma prova oficial inteira no repositório (seção 34 da
   ordem) — só fixtures pequenas e técnicas. */

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** `pages`: cada elemento é uma página, cada página é uma lista de linhas
 *  de texto (topo -> rodapé). Uma linha vazia ("") insere um espaçamento
 *  extra sem texto (nunca produz um TextItem). */
export function buildFixturePdf(pages: string[][]): Uint8Array {
  return buildFixturePdfWithVisuals(pages.map((lines) => ({ lines })));
}

/** Sprint 23 — imagem raster técnica embutida numa página (XObject
 *  `/Subtype/Image`, sem filtro/compressão — bytes RGB crus, mais simples
 *  de montar à mão e suficiente para o pdfjs-dist decodificar via
 *  `page.objs`). `rgbBytes` precisa ter `width*height*3` valores, TODOS no
 *  intervalo 0-127 (ASCII puro) — o builder inteiro monta o PDF como uma
 *  STRING (`TextEncoder().encode` no final), então qualquer byte >= 128
 *  seria reescrito como multi-byte UTF-8 e corromperia o stream; para uma
 *  imagem técnica de teste isso nunca importa (não precisa ser uma cor
 *  "real"). `afterLineIndex` posiciona o `Do` (comando de pintura) logo
 *  após aquela linha de texto ser escrita — a imagem aparece na MESMA
 *  vizinhança Y daquela linha, para testar associação por posição. */
export interface FixtureImageSpec {
  afterLineIndex: number;
  /** Resolução REAL da imagem em pixels (define `rgbBytes.length` exigido
   *  e o tamanho físico do PNG codificado). */
  width: number;
  height: number;
  rgbBytes: number[];
  /** Deslocamento horizontal (pontos) a partir da margem padrão de texto
   *  (x=40) — default 0. */
  xOffset?: number;
  /** Tamanho de EXIBIÇÃO na página (pontos, escala do `cm`) — default
   *  `width`/`height` (1 "pixel" = 1pt, conveniente para imagens pequenas
   *  de teste). Para imagens de alta resolução (ex.: testar o limite de
   *  15MB — Sprint 23.1, seção 6), sempre passar um valor pequeno aqui
   *  (ex.: 20x20pt) para a imagem caber perto da linha-âncora — sem isso,
   *  uma imagem de milhares de pixels de resolução seria desenhada com
   *  milhares de PONTOS de tamanho, muito maior que a própria página, e o
   *  elemento visual acabaria fora de qualquer faixa Y reconhecível
   *  (nunca associado a nenhuma questão). */
  displayWidth?: number;
  displayHeight?: number;
}

/** Vetor técnico (retângulo com traçado) embutido numa página — gera um
 *  `constructPath` real no operatorList do pdfjs-dist (mesma família de op
 *  usada pelo detector de vetor). `afterLineIndex` mesma semântica de
 *  `FixtureImageSpec`. */
export interface FixtureVectorSpec {
  afterLineIndex: number;
  width: number;
  height: number;
  xOffset?: number;
}

export interface FixturePageSpec {
  lines: string[];
  images?: FixtureImageSpec[];
  vectors?: FixtureVectorSpec[];
}

/** Versão completa do builder — `buildFixturePdf` é um atalho para quando
 *  nenhuma página precisa de imagem/vetor embutido. */
export function buildFixturePdfWithVisuals(pages: FixturePageSpec[]): Uint8Array {
  let objNum = 1;
  const catalogObj = objNum++;
  const pagesObj = objNum++;
  const fontObj = objNum++;
  const pageObjNums: number[] = [];
  const contentObjNums: number[] = [];
  const pageStreams: string[] = [];
  const pageImageObjNums: number[][] = []; // por página: lista de objNums de imagem, na ordem de `images`

  for (const page of pages) {
    pageObjNums.push(objNum++);
    contentObjNums.push(objNum++);

    let y = 780;
    const lines: string[] = ["BT", "/F1 10 Tf"];
    const imageObjNumsForPage: number[] = [];
    for (let i = 0; i < page.lines.length; i++) {
      const line = page.lines[i];
      if (line.length > 0) lines.push(`1 0 0 1 40 ${y} Tm (${pdfEscape(line)}) Tj`);

      for (const img of page.images ?? []) {
        if (img.afterLineIndex === i) {
          const imgObjNum = objNum++; // reservado agora, objeto real emitido abaixo
          imageObjNumsForPage.push(imgObjNum);
          const imgIndex = imageObjNumsForPage.length - 1;
          const x = 40 + (img.xOffset ?? 0);
          const imgY = y - 2; // um pouco abaixo da linha, dentro da faixa da MESMA vizinhança Y.
          const displayWidth = img.displayWidth ?? img.width;
          const displayHeight = img.displayHeight ?? img.height;
          lines.push(`ET\nq ${displayWidth} 0 0 ${displayHeight} ${x} ${imgY} cm /Im${imgIndex} Do Q\nBT\n/F1 10 Tf`);
        }
      }
      for (const vec of page.vectors ?? []) {
        if (vec.afterLineIndex === i) {
          const x = 40 + (vec.xOffset ?? 0);
          const vecY = y - 2;
          lines.push(`ET\n${x} ${vecY} ${vec.width} ${vec.height} re S\nBT\n/F1 10 Tf`);
        }
      }

      y -= 14;
    }
    lines.push("ET");
    pageStreams.push(lines.join("\n"));
    pageImageObjNums.push(imageObjNumsForPage);
  }

  let body = "";
  body += `${catalogObj} 0 obj<</Type/Catalog/Pages ${pagesObj} 0 R>>endobj\n`;
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(" ");
  body += `${pagesObj} 0 obj<</Type/Pages/Kids[${kids}]/Count ${pageObjNums.length}>>endobj\n`;
  body += `${fontObj} 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n`;

  for (let i = 0; i < pageObjNums.length; i++) {
    const images = pages[i].images ?? [];
    const imageObjNums = pageImageObjNums[i];
    const xObjectEntries = imageObjNums.map((n, idx) => `/Im${idx} ${n} 0 R`).join(" ");
    const resources = xObjectEntries.length > 0 ? `/Resources<</Font<</F1 ${fontObj} 0 R>>/XObject<<${xObjectEntries}>>>>` : `/Resources<</Font<</F1 ${fontObj} 0 R>>>>`;
    body += `${pageObjNums[i]} 0 obj<</Type/Page/Parent ${pagesObj} 0 R${resources}/MediaBox[0 0 612 842]/Contents ${contentObjNums[i]} 0 R>>endobj\n`;
    const content = pageStreams[i];
    body += `${contentObjNums[i]} 0 obj<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n`;

    for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
      const img = images[imgIdx];
      const objN = imageObjNums[imgIdx];
      if (img.rgbBytes.length !== img.width * img.height * 3) {
        throw new Error(`FixtureImageSpec: rgbBytes deve ter width*height*3 = ${img.width * img.height * 3} valores (recebeu ${img.rgbBytes.length}).`);
      }
      if (img.rgbBytes.some((b) => b < 0 || b > 127)) {
        throw new Error("FixtureImageSpec: rgbBytes deve conter só valores 0-127 (ASCII puro — ver comentário do tipo).");
      }
      // Nunca `String.fromCharCode(...img.rgbBytes)` para imagens grandes —
      // espalhar um array de milhões de números como argumentos individuais
      // estoura a pilha do JS. Monta em pedaços de 64K bytes.
      const CHUNK_SIZE = 65536;
      let pixelStream = "";
      for (let offset = 0; offset < img.rgbBytes.length; offset += CHUNK_SIZE) {
        pixelStream += String.fromCharCode(...img.rgbBytes.slice(offset, offset + CHUNK_SIZE));
      }
      body += `${objN} 0 obj<</Type/XObject/Subtype/Image/Width ${img.width}/Height ${img.height}/ColorSpace/DeviceRGB/BitsPerComponent 8/Length ${pixelStream.length}>>\nstream\n${pixelStream}\nendstream\nendobj\n`;
    }
  }

  const pdf = `%PDF-1.4\n${body}trailer<</Size ${objNum}/Root ${catalogObj} 0 R>>\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/** Monta uma prova técnica com N questões (5 alternativas cada,
 *  enunciado/alternativas técnicas fixas) — uma questão por "bloco",
 *  distribuído numa única página por padrão. `overrides` permite ao
 *  chamador reescrever blocos específicos (spans de página, alternativas
 *  quebradas, etc.) para os cenários de teste da seção 34 da ordem. */
export function buildExamPdf(questionNumbers: number[], pageBreaksAfter: Set<number> = new Set()): Uint8Array {
  const pages: string[][] = [[]];
  for (const n of questionNumbers) {
    let current = pages[pages.length - 1];
    current.push(`QUESTAO ${n}`);
    current.push(`Enunciado tecnico da questao ${n} de teste.`);
    current.push(`A. Alternativa A da questao ${n}`);
    current.push(`B. Alternativa B da questao ${n}`);
    current.push(`C. Alternativa C da questao ${n}`);
    current.push(`D. Alternativa D da questao ${n}`);
    current.push(`E. Alternativa E da questao ${n}`);
    if (pageBreaksAfter.has(n)) pages.push([]);
  }
  return buildFixturePdf(pages);
}

export function buildAnswerKeyPdf(answers: Array<[number, string]>): Uint8Array {
  const lines = answers.map(([n, letter]) => `${n} ${letter}`);
  return buildFixturePdf([lines]);
}

/** Sprint 22.1 — mesmo builder de prova, mas repetindo em CADA página o
 *  cabeçalho real do ENEM/INEP ("<AREA> - <DIA>o dia | Caderno <NUM> -
 *  <COR> - Pagina <N>", confirmado contra o PDF oficial 2019 usado no
 *  smoke desta sprint) — necessário para os testes de
 *  pdfEnemDocumentIdentity.ts. "o" sem acento (ASCII puro, mesma
 *  convenção do resto deste arquivo) casa com a mesma regex tolerante a
 *  "º"/"o" usada no parser real. */
export function buildExamPdfWithHeader(
  questionNumbers: number[],
  header: { day: number; bookletNumber: number; color: string; area?: string }
): Uint8Array {
  const headerLine = `${header.area ?? "MT"} - ${header.day}o dia | Caderno ${header.bookletNumber} - ${header.color} - Pagina 1`;
  const pages: string[][] = [[headerLine]];
  for (const n of questionNumbers) {
    const current = pages[pages.length - 1];
    current.push(`QUESTAO ${n}`);
    current.push(`Enunciado tecnico da questao ${n} de teste.`);
    current.push(`A. Alternativa A da questao ${n}`);
    current.push(`B. Alternativa B da questao ${n}`);
    current.push(`C. Alternativa C da questao ${n}`);
    current.push(`D. Alternativa D da questao ${n}`);
    current.push(`E. Alternativa E da questao ${n}`);
  }
  return buildFixturePdf(pages);
}

/** Sprint 24, seção 10 e 24-G da ordem — fixture técnica reproduzindo
 *  EXATAMENTE a estrutura problemática encontrada no PDF oficial real
 *  (ENEM 2019, Caderno 7 Azul): uma página de duas colunas onde (a) a
 *  coluna esquerda tem um rótulo de diagrama solto posicionado na mesma
 *  faixa Y de um cabeçalho "QUESTÃO N" da coluna direita, e (b) uma
 *  segunda ocorrência onde um valor de tabela da coluna esquerda coincide
 *  em Y com outro cabeçalho da coluna direita — os dois bugs reais
 *  corrigidos nesta sprint (`detectColumnGutter` reescrito + isolamento de
 *  heading em `groupItemsByY`). `leftX`/`rightX` nunca hardcoded no
 *  algoritmo de produção — aqui só posicionam o conteúdo de teste. */
export function buildTwoColumnCollisionFixturePdf(): Uint8Array {
  let objNum = 1;
  const catalogObj = objNum++;
  const pagesObj = objNum++;
  const fontObj = objNum++;
  const pageObj = objNum++;
  const contentObj = objNum++;

  const leftX = 40;
  const rightX = 300;
  const lines: string[] = ["BT", "/F1 10 Tf"];
  const put = (x: number, y: number, text: string) => lines.push(`1 0 0 1 ${x} ${y} Tm (${pdfEscape(text)}) Tj`);

  // Coluna esquerda: corpo de texto repetido o bastante para o algoritmo
  // de detecção de gutter (moda de X por metade da página) reconhecer a
  // margem esquerda com confiança — nunca menos que o mínimo de repetição
  // exigido pela implementação real.
  for (let i = 0; i < 6; i++) put(leftX, 700 - i * 14, `Texto corrido da coluna esquerda, linha ${i}.`);
  // Rótulo de diagrama solto da coluna esquerda, na MESMA faixa Y (arred.)
  // do cabeçalho da coluna direita abaixo — a colisão real encontrada.
  put(leftX, 594, "d");
  for (let i = 0; i < 4; i++) put(leftX, 580 - i * 14, `Mais texto da coluna esquerda, linha ${i}.`);
  put(leftX, 400, "QUESTAO 1");
  for (let i = 0; i < 5; i++) put(leftX, 386 - i * 14, `Enunciado tecnico da questao 1, linha ${i}.`);
  put(leftX, 300, "A. Alternativa A da questao 1");
  put(leftX, 286, "B. Alternativa B da questao 1");
  put(leftX, 272, "C. Alternativa C da questao 1");
  put(leftX, 258, "D. Alternativa D da questao 1");
  put(leftX, 244, "E. Alternativa E da questao 1");

  // Coluna direita: repetição para a margem direita ser reconhecida com
  // confiança, e o cabeçalho "QUESTAO 2" exatamente na MESMA linha Y
  // arredondada do rótulo solto "d" da coluna esquerda (y=594).
  for (let i = 0; i < 6; i++) put(rightX, 700 - i * 14, `Texto corrido da coluna direita, linha ${i}.`);
  put(rightX, 594, "QUESTAO 2");
  for (let i = 0; i < 5; i++) put(rightX, 580 - i * 14, `Enunciado tecnico da questao 2, linha ${i}.`);
  put(rightX, 494, "A. Alternativa A da questao 2");
  put(rightX, 480, "B. Alternativa B da questao 2");
  put(rightX, 466, "C. Alternativa C da questao 2");
  put(rightX, 452, "D. Alternativa D da questao 2");
  put(rightX, 438, "E. Alternativa E da questao 2");

  lines.push("ET");
  const content = lines.join("\n");

  let body = "";
  body += `${catalogObj} 0 obj<</Type/Catalog/Pages ${pagesObj} 0 R>>endobj\n`;
  body += `${pagesObj} 0 obj<</Type/Pages/Kids[${pageObj} 0 R]/Count 1>>endobj\n`;
  body += `${fontObj} 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n`;
  body += `${pageObj} 0 obj<</Type/Page/Parent ${pagesObj} 0 R/Resources<</Font<</F1 ${fontObj} 0 R>>>>/MediaBox[0 0 566.929 842]/Contents ${contentObj} 0 R>>endobj\n`;
  body += `${contentObj} 0 obj<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n`;

  const pdf = `%PDF-1.4\n${body}trailer<</Size ${objNum}/Root ${catalogObj} 0 R>>\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/** Gabarito técnico com as duas linhas de identidade reais do ENEM/INEP
 *  ("<DIA>o DIA - CADERNO <NUM>" e "<COR> Gabarito <ANO>"), mais as
 *  respostas. */
export function buildAnswerKeyPdfWithIdentity(
  answers: Array<[number, string]>,
  identity: { day: number; bookletNumber: number; color: string; year: number }
): Uint8Array {
  const lines = [
    `${identity.day}o DIA - CADERNO ${identity.bookletNumber}`,
    `${identity.color} Gabarito ${identity.year}`,
    ...answers.map(([n, letter]) => `${n} ${letter}`),
  ];
  return buildFixturePdf([lines]);
}

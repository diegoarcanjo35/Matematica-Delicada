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
  let objNum = 1;
  const catalogObj = objNum++;
  const pagesObj = objNum++;
  const fontObj = objNum++;
  const pageObjNums: number[] = [];
  const contentObjNums: number[] = [];
  const pageStreams: string[] = [];

  for (const page of pages) {
    pageObjNums.push(objNum++);
    contentObjNums.push(objNum++);

    let y = 780;
    const lines: string[] = ["BT", "/F1 10 Tf"];
    for (const line of page) {
      if (line.length > 0) lines.push(`1 0 0 1 40 ${y} Tm (${pdfEscape(line)}) Tj`);
      y -= 14;
    }
    lines.push("ET");
    pageStreams.push(lines.join("\n"));
  }

  let body = "";
  body += `${catalogObj} 0 obj<</Type/Catalog/Pages ${pagesObj} 0 R>>endobj\n`;
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(" ");
  body += `${pagesObj} 0 obj<</Type/Pages/Kids[${kids}]/Count ${pageObjNums.length}>>endobj\n`;
  body += `${fontObj} 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n`;
  for (let i = 0; i < pageObjNums.length; i++) {
    body += `${pageObjNums[i]} 0 obj<</Type/Page/Parent ${pagesObj} 0 R/Resources<</Font<</F1 ${fontObj} 0 R>>>>/MediaBox[0 0 612 842]/Contents ${contentObjNums[i]} 0 R>>endobj\n`;
    const content = pageStreams[i];
    body += `${contentObjNums[i]} 0 obj<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n`;
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

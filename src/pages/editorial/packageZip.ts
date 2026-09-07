/* Leitura LOCAL do pacote ZIP no navegador — Sprint 19, seção 11 da ordem:
   "o frontend pode ler o mesmo ZIP localmente e criar Blob/Object URLs
   apenas para exibição... a validação do servidor continua sendo fonte de
   verdade, o parser do navegador NUNCA a substitui." Usado só para montar
   thumbnails ANTES de aplicar — nunca para decidir se o pacote é válido
   (isso é 100% resposta do backend). Mesma biblioteca do backend
   (`fflate`), API síncrona de alto nível aqui é aceitável porque o arquivo
   já está inteiro em memória como `File` escolhido pela própria usuária
   (implicações de "zip bomb" adversarial não se aplicam a alguém abrindo o
   próprio arquivo) — mesmo assim aplicamos um limite de sanidade (seção 11:
   "aplicar limites também no parser frontend"), nunca um `unzipSync` sem
   nenhum teto. */

import { unzipSync } from "fflate";

/** Mesma ordem de grandeza dos limites do backend (Sprint 19, seção 8) —
 *  só para não travar a aba do navegador com um arquivo absurdo antes
 *  mesmo de o servidor validar. */
const FRONTEND_MAX_ZIP_BYTES = 20 * 1024 * 1024;

export interface PackageThumbnails {
  /** path dentro do ZIP -> Object URL (`URL.createObjectURL`). */
  urls: Map<string, string>;
  /** Libera TODOS os Object URLs criados — chamar ao trocar de pacote ou
   *  desmontar o componente (nunca deixar vazar). */
  revokeAll: () => void;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Extrai SÓ os `paths` pedidos (as imagens que o preview do servidor já
 *  confirmou válidas) e devolve um Object URL por caminho — nunca tenta
 *  decodificar o ZIP inteiro nem exibir nada que o servidor não tenha
 *  validado primeiro. Falha silenciosamente (path ausente do mapa) para
 *  qualquer entrada que não possa ser lida — a tela mostra "sem
 *  pré-visualização" para aquele item, nunca quebra a página inteira. */
export async function buildPackageThumbnails(file: File, paths: string[]): Promise<PackageThumbnails> {
  const urls = new Map<string, string>();
  if (file.size > FRONTEND_MAX_ZIP_BYTES || paths.length === 0) {
    return { urls, revokeAll: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
  }

  try {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const wanted = new Set(paths);
    const unzipped = unzipSync(buffer, { filter: (entry) => wanted.has(entry.name) });
    for (const path of paths) {
      const bytes = unzipped[path];
      if (!bytes) continue;
      const extension = path.split(".").pop()?.toLowerCase() ?? "";
      const mime = MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
      const blob = new Blob([new Uint8Array(bytes)], { type: mime });
      urls.set(path, URL.createObjectURL(blob));
    }
  } catch {
    // ZIP ilegível no navegador — sem thumbnails, a prévia textual do
    // servidor (código/enunciado/padrão/contagem) continua sendo exibida
    // normalmente.
  }

  return { urls, revokeAll: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
}

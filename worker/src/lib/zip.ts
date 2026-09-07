/* Leitor de ZIP hardened — Sprint 19, seção 8 da ordem.

   Biblioteca escolhida: `fflate` (pure JS, ~apenas alguns KB, sem
   dependência nativa/Node filesystem, mantida, já amplamente usada em
   Workers/browser — ver relatório final desta sprint para a justificativa
   completa). Usamos SÓ a API de streaming de baixo nível (`Unzip` +
   `UnzipInflate`, registrados manualmente — o construtor de `Unzip` NÃO
   registra DEFLATE por padrão, só "stored"/sem compressão; confirmado lendo
   o próprio código-fonte de fflate antes de escrever este módulo), NUNCA
   `unzipSync`/`unzip()` de alto nível: essas funções decodificam TODAS as
   entradas de uma vez, sem qualquer chance de abortar no meio com base em
   limites — exatamente o "unzipSync que infla o ZIP bomb inteiro antes de
   aplicar os limites" que a ordem proíbe explicitamente.

   Com a API de streaming, cada entrada é anunciada via `onfile(file)` ANTES
   de qualquer byte ser descomprimido — decidimos ali (com base em
   `file.originalSize`, quando o cabeçalho local o declara) se vale a pena
   sequer começar a descomprimir. Mesmo quando o tamanho declarado está
   ausente (ZIP criado em modo streaming, sem o tamanho no cabeçalho local —
   ver `UnzipFile.originalSize?: number` em fflate), os limites continuam
   sendo aplicados de verdade: o callback `ondata` soma os bytes REAIS
   entregues a cada chamada e aborta (via `file.terminate()`) no instante em
   que qualquer limite (por arquivo ou total) seria ultrapassado — nunca
   confiando só no cabeçalho, que uma entrada maliciosa pode mentir. */

import { Unzip, UnzipInflate, type UnzipFile } from "fflate";

/* Sprint 19, seção 8 da ordem — limites de segurança do pacote ZIP.
   Sugestão da própria ordem, adotada sem alteração: os valores cobrem
   folgadamente o caso de uso real (poucas dezenas de imagens pequenas por
   pacote) sem abrir espaço para exaustão de memória/CPU do Worker (limite
   de memória de um Worker é da ordem de 128MB; 40MB descomprimidos deixa
   margem confortável para o resto do processamento — parsing de CSV/JSON,
   hashing, buffers intermediários). */
export const PACKAGE_MAX_ZIP_COMPRESSED_BYTES = 20 * 1024 * 1024; // 20 MB
export const PACKAGE_MAX_TOTAL_UNCOMPRESSED_BYTES = 40 * 1024 * 1024; // 40 MB
export const PACKAGE_MAX_ENTRIES = 250;
export const PACKAGE_MAX_SINGLE_FILE_BYTES = 8 * 1024 * 1024; // 8 MB — mesmo teto de imagem da Sprint 18.
export const PACKAGE_MAX_QUESTIONS_PER_PACKAGE = 100;

export interface ZipEntry {
  /** Nome bruto exatamente como veio do cabeçalho local do ZIP — path
   *  traversal/absoluto/drive-letter são responsabilidade do CHAMADOR
   *  validar (ver `validateZipEntryPath` abaixo), nunca filtrados aqui de
   *  forma silenciosa — o pacote inteiro deve ser rejeitado com erro
   *  explícito, não "limpo" por trás das costas de Andreia. */
  path: string;
  bytes: Uint8Array;
}

export interface ZipReadResult {
  ok: boolean;
  entries?: ZipEntry[];
  error?: string;
}

function concatChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** Lê um ZIP inteiro para memória com todos os limites de segurança da
 *  seção 8 aplicados de forma incremental — nunca uma extração ingênua.
 *  Entradas de diretório (nome terminado em "/") são contadas para o limite
 *  de quantidade, mas nunca extraídas (não têm conteúdo). */
export async function readZipSafely(
  zipBytes: Uint8Array,
  limits: {
    maxCompressedBytes: number;
    maxTotalUncompressedBytes: number;
    maxEntries: number;
    maxSingleFileBytes: number;
  } = {
    maxCompressedBytes: PACKAGE_MAX_ZIP_COMPRESSED_BYTES,
    maxTotalUncompressedBytes: PACKAGE_MAX_TOTAL_UNCOMPRESSED_BYTES,
    maxEntries: PACKAGE_MAX_ENTRIES,
    maxSingleFileBytes: PACKAGE_MAX_SINGLE_FILE_BYTES,
  }
): Promise<ZipReadResult> {
  if (zipBytes.byteLength === 0) return { ok: false, error: "Pacote ZIP vazio." };
  if (zipBytes.byteLength > limits.maxCompressedBytes) {
    return { ok: false, error: `Pacote ZIP excede o limite de ${limits.maxCompressedBytes} bytes comprimidos.` };
  }

  const entries: ZipEntry[] = [];
  let totalUncompressed = 0;
  let entryCount = 0;
  let aborted = false;
  let errorMessage: string | null = null;

  function abort(message: string): void {
    if (aborted) return;
    aborted = true;
    errorMessage = message;
  }

  const unzip = new Unzip((file: UnzipFile) => {
    if (aborted) return;
    entryCount++;
    if (entryCount > limits.maxEntries) {
      abort(`Pacote ZIP excede o limite de ${limits.maxEntries} entradas.`);
      file.terminate();
      return;
    }

    // Diretório — só existe para contar no limite acima; nunca extraído.
    if (file.name.endsWith("/")) return;

    // Checagem PRÉVIA com o tamanho declarado no cabeçalho local, quando
    // disponível (nunca a única linha de defesa — ver checagem incremental
    // em `ondata` abaixo, que vale mesmo se este valor estiver ausente ou
    // mentiroso).
    if (typeof file.originalSize === "number") {
      if (file.originalSize > limits.maxSingleFileBytes) {
        abort(`Arquivo "${file.name}" excede o limite individual de ${limits.maxSingleFileBytes} bytes (declarado).`);
        file.terminate();
        return;
      }
      if (totalUncompressed + file.originalSize > limits.maxTotalUncompressedBytes) {
        abort(`Pacote ZIP excede o limite total descomprimido de ${limits.maxTotalUncompressedBytes} bytes (declarado).`);
        file.terminate();
        return;
      }
    }

    const chunks: Uint8Array[] = [];
    let fileBytes = 0;

    file.ondata = (err, chunk, final) => {
      if (aborted) return;
      if (err) {
        abort(`Falha ao descomprimir "${file.name}".`);
        return;
      }
      if (chunk) {
        fileBytes += chunk.length;
        totalUncompressed += chunk.length;
        // Checagem INCREMENTAL — a única que realmente protege contra um
        // ZIP bomb que declara (ou omite) um tamanho mentiroso no
        // cabeçalho: aborta no INSTANTE em que os bytes REAIS já entregues
        // ultrapassam o limite, nunca espera a descompressão terminar.
        if (fileBytes > limits.maxSingleFileBytes) {
          abort(`Arquivo "${file.name}" excede o limite individual de ${limits.maxSingleFileBytes} bytes (real).`);
          file.terminate();
          return;
        }
        if (totalUncompressed > limits.maxTotalUncompressedBytes) {
          abort(`Pacote ZIP excede o limite total descomprimido de ${limits.maxTotalUncompressedBytes} bytes (real).`);
          file.terminate();
          return;
        }
        chunks.push(chunk);
      }
      if (final && !aborted) {
        entries.push({ path: file.name, bytes: concatChunks(chunks, fileBytes) });
      }
    };

    file.start();
  });
  unzip.register(UnzipInflate);

  try {
    unzip.push(zipBytes, true);
  } catch (error) {
    return { ok: false, error: `Pacote ZIP malformado: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (aborted) return { ok: false, error: errorMessage! };
  return { ok: true, entries };
}

/* --------------------------- Segurança de path -----------------------------
   Sprint 19, seção 7/8 — nunca aceitar path absoluto, "..", drive letter,
   backslash (namespace único, sempre "/", mesmo em ZIPs gerados no Windows),
   nem uma entrada fora do namespace esperado. Reaproveitado tanto pela
   validação genérica do ZIP quanto pela validação específica do manifest
   (worker/src/lib/manifest.ts). */

export function isSafeZipEntryPath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.includes("\\")) return false; // namespace único — sempre "/", nunca separador de Windows.
  if (path.startsWith("/")) return false; // caminho absoluto (POSIX).
  if (/^[A-Za-z]:/.test(path)) return false; // drive letter (C:\..., D:...).
  if (path.split("/").some((segment) => segment === "..")) return false; // path traversal, em qualquer profundidade.
  if (path.split("/").some((segment) => segment === "." || segment === "")) return false; // "//" ou "/./" — normalização ambígua.
  return true;
}

/** Normaliza para comparação de duplicidade (case-fold) — dois nomes que só
 *  diferem em maiúsculas/minúsculas podem colidir no mesmo sistema de
 *  arquivos de origem (Windows/macOS, ambos case-insensitive por padrão) e
 *  nunca devem ser tratados como referências distintas e válidas
 *  simultaneamente. */
export function normalizeZipPathForComparison(path: string): string {
  return path.toLowerCase();
}

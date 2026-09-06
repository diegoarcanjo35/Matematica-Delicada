/* Sprint 18, seção 11/20 da ordem — "validar conteúdo/MIME real, não apenas
   extensão". Nunca confiamos no Content-Type declarado pelo cliente nem na
   extensão do nome de arquivo — os primeiros bytes do arquivo (assinatura/
   "magic bytes") são a única fonte de verdade sobre o formato real. Só os
   três formatos aceitos nesta sprint (PNG/JPEG/WebP — nunca SVG novo,
   seção 11) têm assinatura reconhecida aqui; qualquer outro conteúdo
   (incluindo um SVG disfarçado de .png) retorna `null` e é rejeitado pelo
   chamador. */

import { ALLOWED_IMAGE_UPLOAD_MIME_TYPES, type AllowedImageUploadMimeType } from "./questionsValidation";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function isWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  return riff === "RIFF" && webp === "WEBP";
}

/** Detecta o MIME real pelos bytes de assinatura. Retorna `null` para
 *  qualquer conteúdo não reconhecido como um dos três formatos aceitos
 *  (nunca "adivinha" nem cai de volta no Content-Type declarado). */
export function sniffImageMimeType(bytes: Uint8Array): AllowedImageUploadMimeType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  if (isWebp(bytes)) return "image/webp";
  return null;
}

export function isDeclaredMimeConsistent(declared: string | null, sniffed: AllowedImageUploadMimeType): boolean {
  // O Content-Type declarado pelo navegador/cliente é só um sinal
  // ADICIONAL (nunca a fonte de verdade) — quando presente e reconhecível,
  // exigimos que bata com o que os bytes realmente dizem, fechando o caso
  // de um arquivo renomeado/disfarçado que ainda assim tivesse assinatura
  // válida de outro formato aceito.
  if (!declared) return true;
  return !(ALLOWED_IMAGE_UPLOAD_MIME_TYPES as readonly string[]).includes(declared) || declared === sniffed;
}

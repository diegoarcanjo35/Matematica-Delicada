/* Primitivas criptográficas — só Web Crypto (nativa do runtime Workers).
   Nenhuma criptografia própria foi inventada. */

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    "="
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Token opaco de alta entropia (256 bits), para sessão e tokens de e-mail. */
export function generateOpaqueToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** SHA-256 do token, em hex — é o que fica persistido no D1 (nunca o token bruto). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* Hash de senha — PBKDF2-HMAC-SHA256, primitiva consolidada disponível via
   Web Crypto no runtime Workers (SubtleCrypto). Parâmetros documentados em
   docs/AUTENTICACAO.md.
   600.000 iterações — recomendação atual da OWASP Password Storage Cheat Sheet
   para PBKDF2-HMAC-SHA256 (ver referência no docs/AUTENTICACAO.md). Benchmark
   local: mediana de 143ms/hash (worker/scripts/benchmark-pbkdf2.mjs) — viável. */
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH = "SHA-256";
const PBKDF2_KEY_LENGTH_BITS = 256;
const PBKDF2_SALT_BYTES = 16;
const PASSWORD_HASH_VERSION = "pbkdf2-sha256-v1";

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(PBKDF2_SALT_BYTES);
  crypto.getRandomValues(salt);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    keyMaterial,
    PBKDF2_KEY_LENGTH_BITS
  );

  const saltB64 = toBase64Url(salt);
  const hashB64 = toBase64Url(new Uint8Array(derivedBits));
  // Formato persistido: versão$iterações$salt$hash — permite migrar parâmetros no futuro.
  return `${PASSWORD_HASH_VERSION}$${PBKDF2_ITERATIONS}$${saltB64}$${hashB64}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== PASSWORD_HASH_VERSION) return false;
  const [, iterationsRaw, saltB64, hashB64] = parts;
  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;

  const salt = fromBase64Url(saltB64);
  const expected = fromBase64Url(hashB64);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: PBKDF2_HASH },
    keyMaterial,
    expected.length * 8
  );
  const actual = new Uint8Array(derivedBits);

  return timingSafeEqual(actual, expected);
}

/** Verdadeiro se o hash armazenado usa parâmetros mais fracos que o atual —
 *  usado para upgrade oportunista após um login com senha correta. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== PASSWORD_HASH_VERSION) return true;
  const iterations = Number(parts[1]);
  return !Number.isInteger(iterations) || iterations < PBKDF2_ITERATIONS;
}

/** Comparação em tempo constante — evita side-channel de timing. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

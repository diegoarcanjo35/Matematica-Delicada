/* Validação no servidor — nunca confiar só na validação do cliente. */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email.trim());
}

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256; // limite técnico contra abuso (DoS em PBKDF2), não regra arbitrária

export function isValidPassword(password: string): boolean {
  return (
    typeof password === "string" &&
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH
  );
}

export function isValidName(name: string): boolean {
  return typeof name === "string" && name.trim().length >= 2 && name.trim().length <= 120;
}

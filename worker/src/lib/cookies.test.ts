// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildExpiredSessionCookie, buildSessionCookie, SESSION_COOKIE_NAME } from "./cookies";

describe("buildSessionCookie — atributos de segurança", () => {
  it("inclui Secure por padrão (omitSecure=false)", () => {
    const cookie = buildSessionCookie("token123", false);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=token123`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("omite Secure só quando explicitamente solicitado (omitSecure=true)", () => {
    const cookie = buildSessionCookie("token123", true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });
});

describe("buildExpiredSessionCookie — logout expira com os mesmos atributos relevantes", () => {
  it("cookie expirado mantém Secure por padrão e expira (Max-Age=0)", () => {
    const cookie = buildExpiredSessionCookie(false);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("cookie expirado respeita omitSecure=true", () => {
    const cookie = buildExpiredSessionCookie(true);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).not.toContain("Secure");
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageUploadZone } from "./ImageUploadZone";
import type { QuestionImageDto } from "../../api/editorialClient";

/* Sprint 18.1, seção C/B da correção de auditoria — item de teste explícito:
   "imagem antiga local continua aparecendo no editor; imagem R2 usa a rota
   controlada; nenhuma URL externa arbitrária é aceita/gerada." Mesma
   convenção de mock de fetch global usada em EditorialQuestionFormPage.test.tsx. */

function mockApi() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      let body: unknown = null;
      if (init?.body && typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ url, method, body });
      return new Response(JSON.stringify({ ok: true, changed: true }), { status: 200 });
    })
  );
  return calls;
}

const LOCAL_IMAGE: QuestionImageDto = {
  id: "img-local-1",
  assetRef: "assets/questoes/antiga.png",
  altText: "Imagem antiga",
  caption: null,
  position: 0,
  placement: "enunciado",
  alternativeLetter: null,
  storageKind: "local",
};

const R2_IMAGE: QuestionImageDto = {
  id: "img-r2-1",
  assetRef: "questions/q1/img-r2-1.png",
  altText: "Imagem nova",
  caption: null,
  position: 0,
  placement: "enunciado",
  alternativeLetter: null,
  storageKind: "r2",
};

const MALICIOUS_LOCAL_IMAGE: QuestionImageDto = {
  ...LOCAL_IMAGE,
  id: "img-malicious",
  assetRef: "http://evil.example/x.png",
};

describe("ImageUploadZone — compatibilidade local/R2 e edição de alt text (correção 18.1)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("imagem local legada continua aparecendo no editor via caminho local, nunca via /api/question-media", () => {
    mockApi();
    render(<ImageUploadZone questionId="q1" placement="enunciado" images={[LOCAL_IMAGE]} onChanged={() => {}} />);
    const img = screen.getByAltText("Imagem antiga") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/assets/questoes/antiga.png");
    expect(img.getAttribute("src")).not.toContain("/api/question-media/");
  });

  it("imagem R2 usa a rota controlada /api/question-media/:id", () => {
    mockApi();
    render(<ImageUploadZone questionId="q1" placement="enunciado" images={[R2_IMAGE]} onChanged={() => {}} />);
    const img = screen.getByAltText("Imagem nova") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/question-media/img-r2-1");
  });

  it("nenhuma URL externa arbitrária é aceita/gerada para uma imagem local com assetRef malicioso", () => {
    mockApi();
    render(<ImageUploadZone questionId="q1" placement="enunciado" images={[MALICIOUS_LOCAL_IMAGE]} onChanged={() => {}} />);
    const img = screen.getByAltText("Imagem antiga") as HTMLImageElement;
    expect(img.getAttribute("src")).not.toBe("http://evil.example/x.png");
    // React/jsdom omitem o atributo quando o valor é string vazia — o que
    // importa é que a URL maliciosa nunca chega ao DOM de nenhuma forma.
    expect(img.getAttribute("src") ?? "").toBe("");
  });

  it("editar a descrição de uma imagem existente envia PATCH dedicado (sem remover/reenviar) e nunca toca R2/bytes", async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    const onChanged = vi.fn();
    render(<ImageUploadZone questionId="q1" placement="enunciado" images={[R2_IMAGE]} onChanged={onChanged} />);

    await user.click(screen.getByRole("button", { name: "Editar descrição" }));
    const input = screen.getByLabelText("Texto alternativo");
    await user.clear(input);
    await user.type(input, "Descrição corrigida");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeDefined();
      expect(patch!.url).toBe("/api/editorial/questions/q1/images/img-r2-1");
      expect(patch!.body).toMatchObject({ altText: "Descrição corrigida" });
      expect(onChanged).toHaveBeenCalled();
    });
    // Nunca um novo upload multipart disparado por uma edição de descrição.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageUploadZone } from "./ImageUploadZone";
import { localAssetUrl, type QuestionImageDto } from "../../api/editorialClient";

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

/* Sprint 18.2, seção 3 da correção — whitelist POSITIVA de localAssetUrl:
   só aceita algo equivalente a
   ^assets/questoes/[A-Za-z0-9_/-]+\.(png|jpg|jpeg|svg|webp)$; qualquer outra
   coisa retorna "" (falha seguramente inerte, nunca uma URL externa). */
describe("localAssetUrl — whitelist exata (correção 18.2, seção 3)", () => {
  it("aceita caminhos locais válidos dentro do namespace histórico", () => {
    expect(localAssetUrl("assets/questoes/grafico.png")).toBe("/assets/questoes/grafico.png");
    expect(localAssetUrl("assets/questoes/sub/a.webp")).toBe("/assets/questoes/sub/a.webp");
  });

  it("rejeita qualquer coisa fora do namespace/formato exatos", () => {
    expect(localAssetUrl("https://evil.example/x.png")).toBe("");
    expect(localAssetUrl("//evil.com/x.png")).toBe(""); // protocol-relative — o navegador resolveria como externo.
    expect(localAssetUrl("javascript:alert(1)")).toBe("");
    expect(localAssetUrl("outro-diretorio/x.png")).toBe("");
    expect(localAssetUrl("assets/questoes/../x.png")).toBe("");
  });
});

/* Sprint 18.2, seção 2 da correção — idempotência REAL do retry na UI: o
   mutationId agora é reaproveitado (nunca crypto.randomUUID() a cada
   clique) quando a MESMA tentativa (mesmo arquivo/altText/placement, ou
   mesmo imageId/altText/caption para edição) é reenviada depois de uma
   falha de REDE (resposta nunca chegou) — e trocado por um novo assim que
   qualquer dado muda, ou assim que uma resposta HTTP conhecida (sucesso ou
   4xx/409) chega. */
describe("Retry idempotente na UI (correção 18.2, seção 2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function extractMutationId(init?: RequestInit): string | null {
    if (init?.body instanceof FormData) return (init.body.get("mutationId") as string | null) ?? null;
    if (typeof init?.body === "string") {
      try {
        return (JSON.parse(init.body) as { mutationId?: string }).mutationId ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** `failCount` respostas de REDE (fetch lançando, nunca uma resposta HTTP)
   *  antes de suceder — mesma distinção que `isNetworkFailure` (mutationId.ts)
   *  usa para decidir se mantém o estado de retry. */
  function mockApiFlaky(failCount: number) {
    const calls: Array<{ method: string; mutationId: string | null }> = [];
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ method, mutationId: extractMutationId(init) });
        attempt++;
        if (attempt <= failCount) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ ok: true, changed: true, image: R2_IMAGE }), { status: 200 });
      })
    );
    return calls;
  }

  it("upload: retry manual após falha de rede (mesmo arquivo/alt text) reaproveita o MESMO mutationId; sucesso limpa o estado", async () => {
    const calls = mockApiFlaky(1);
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const { container } = render(<ImageUploadZone questionId="q1" placement="enunciado" images={[]} onChanged={onChanged} />);

    const file = new File([new Uint8Array([137, 80, 78, 71])], "foto.png", { type: "image/png" });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, file);
    await user.type(screen.getByLabelText("Texto alternativo (obrigatório)"), "Gráfico");

    await user.click(screen.getByRole("button", { name: "Enviar imagem" }));
    await waitFor(() => expect(screen.getByText(/não foi possível enviar a imagem/i)).toBeInTheDocument());
    expect(calls).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Enviar imagem" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls).toHaveLength(2);
    expect(calls[0].mutationId).not.toBeNull();
    expect(calls[1].mutationId).toBe(calls[0].mutationId);
  });

  it("upload: mudar o alt text entre tentativas gera um mutationId NOVO (nunca reaproveita)", async () => {
    const calls = mockApiFlaky(99); // sempre falha por rede — só a identidade dos mutationIds importa aqui.
    const user = userEvent.setup();
    const { container } = render(<ImageUploadZone questionId="q1" placement="enunciado" images={[]} onChanged={() => {}} />);

    const file = new File([new Uint8Array([137, 80, 78, 71])], "foto.png", { type: "image/png" });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, file);
    const altInput = screen.getByLabelText("Texto alternativo (obrigatório)");
    await user.type(altInput, "Primeiro texto");
    await user.click(screen.getByRole("button", { name: "Enviar imagem" }));
    await waitFor(() => expect(calls).toHaveLength(1));

    await user.clear(altInput);
    await user.type(altInput, "Segundo texto, diferente");
    await user.click(screen.getByRole("button", { name: "Enviar imagem" }));
    await waitFor(() => expect(calls).toHaveLength(2));

    expect(calls[1].mutationId).not.toBe(calls[0].mutationId);
  });

  it("edição de alt text: retry manual após falha de rede (mesmo texto) reaproveita o MESMO mutationId; sucesso limpa o estado", async () => {
    const calls = mockApiFlaky(1);
    const user = userEvent.setup();
    const onChanged = vi.fn();
    render(<ImageUploadZone questionId="q1" placement="enunciado" images={[R2_IMAGE]} onChanged={onChanged} />);

    await user.click(screen.getByRole("button", { name: "Editar descrição" }));
    const input = screen.getByLabelText("Texto alternativo");
    await user.clear(input);
    await user.type(input, "Descrição corrigida");

    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(screen.getByText(/não foi possível salvar o texto alternativo/i)).toBeInTheDocument());
    expect(calls).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls).toHaveLength(2);
    expect(calls[0].mutationId).not.toBeNull();
    expect(calls[1].mutationId).toBe(calls[0].mutationId);
  });

  it("edição de alt text: mudar o texto entre tentativas gera um mutationId NOVO", async () => {
    const calls = mockApiFlaky(99);
    const user = userEvent.setup();
    render(<ImageUploadZone questionId="q1" placement="enunciado" images={[R2_IMAGE]} onChanged={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Editar descrição" }));
    const input = screen.getByLabelText("Texto alternativo");
    await user.clear(input);
    await user.type(input, "Primeira tentativa");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(calls).toHaveLength(1));

    await user.clear(input);
    await user.type(input, "Segunda tentativa, texto diferente");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(calls).toHaveLength(2));

    expect(calls[1].mutationId).not.toBe(calls[0].mutationId);
  });
});

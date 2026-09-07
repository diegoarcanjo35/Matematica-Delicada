/* Fake mínimo de R2Bucket para testes unitários — Sprint 18, estendido na
   Sprint 19 com `head()` (idempotência de retry do Pacote ZIP, seção 13 da
   ordem — precisa de customMetadata/httpMetadata/size SEM baixar o corpo).
   Implementa só a fatia da interface real que os serviços usam (put/get/
   head/delete), em memória, sem nenhuma dependência externa. Nunca usado
   por código de produção — só por worker/testing/*.test.ts. */

export interface FakeR2StoredObject {
  key: string;
  bytes: Uint8Array;
  contentType: string | null;
  customMetadata: Record<string, string>;
}

export class FakeR2Bucket {
  private readonly store = new Map<string, FakeR2StoredObject>();
  /** Espelha put()/delete() reais — exposto só para os testes provarem
   *  "objeto foi gravado"/"objeto foi limpo", nunca usado pelo serviço. */
  readonly deletedKeys: string[] = [];

  async put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
  ): Promise<void> {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.store.set(key, {
      key,
      bytes,
      contentType: options?.httpMetadata?.contentType ?? null,
      customMetadata: options?.customMetadata ?? {},
    });
  }

  async get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } | null> {
    const object = this.store.get(key);
    if (!object) return null;
    const bytes = object.bytes;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return { body, httpMetadata: { contentType: object.contentType ?? undefined }, customMetadata: object.customMetadata };
  }

  /** Sprint 19, seção 13 da ordem — metadados sem baixar o corpo, usado
   *  pelo apply do Pacote ZIP para checar se uma chave determinística já
   *  existe (resto órfão de uma tentativa anterior) e se pode ser
   *  reutilizada com segurança. */
  async head(key: string): Promise<{ size: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } | null> {
    const object = this.store.get(key);
    if (!object) return null;
    return { size: object.bytes.byteLength, httpMetadata: { contentType: object.contentType ?? undefined }, customMetadata: object.customMetadata };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.deletedKeys.push(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  size(): number {
    return this.store.size;
  }
}

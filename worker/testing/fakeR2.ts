/* Fake mínimo de R2Bucket para testes unitários — Sprint 18. Implementa só
   a fatia da interface real que worker/src/services/questionMediaService.ts
   usa (put/get/delete), em memória, sem nenhuma dependência externa. Nunca
   usado por código de produção — só por worker/testing/*.test.ts. */

export interface FakeR2StoredObject {
  key: string;
  bytes: Uint8Array;
  contentType: string | null;
}

export class FakeR2Bucket {
  private readonly store = new Map<string, FakeR2StoredObject>();
  /** Espelha put()/delete() reais — exposto só para os testes provarem
   *  "objeto foi gravado"/"objeto foi limpo", nunca usado pelo serviço. */
  readonly deletedKeys: string[] = [];

  async put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<void> {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.store.set(key, { key, bytes, contentType: options?.httpMetadata?.contentType ?? null });
  }

  async get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null> {
    const object = this.store.get(key);
    if (!object) return null;
    const bytes = object.bytes;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return { body, httpMetadata: { contentType: object.contentType ?? undefined } };
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

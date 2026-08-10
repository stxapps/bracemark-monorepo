type WorkerResult = { ok: true; hash: Uint8Array } | { ok: false; error: string };

// The worker path for deriveArgon2Hash, isolated in its own module so it's only ever
// pulled in via a dynamic import when the 'worker' runner is selected (bracemark-web). Apps
// that run Argon2id on the main thread (the browser extension — see setArgon2Runner)
// never import this module, so their bundler emits neither this code nor the worker
// chunk it references.
//
// The worker URL is resolved relative to this module so each consuming bundler
// (Turbopack for bracemark-web, Vite/wxt for the extension) emits its own worker chunk from
// the package source.
export function deriveInWorker(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./argon2.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      const data = event.data;
      worker.terminate();

      if (data.ok) resolve(data.hash);
      else reject(new Error(data.error));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage({ password, salt });
  });
}

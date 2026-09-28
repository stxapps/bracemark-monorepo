import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';

// A stand-in api that answers every request with one status — the server that is
// gone but still answers: a crashed Worker (500), or a route that no longer
// exists (404). The Android emulator reaches the local api only through its
// `adb reverse tcp:8787` mapping, so pointing that mapping here instead is the
// whole fault: the app is untouched, and the real api keeps serving every other
// client (docs/e2e.md, _scale, loading and offline_).
//
// Android only, and not for want of trying on iOS: the simulator shares this
// Mac's loopback, so its :8787 IS the real api's listener. There is no
// per-device route to swap — the lever left there is freezing the process
// (api-pause.ts), which is a hang, a different fault.
//
// The body is plain text, not the api's JSON error shape, on purpose: a server
// that has disappeared does not speak the contract, and a client that only
// survives well-formed errors has not survived this.

export interface FaultApi {
  port: number;
  answer(status: number): void;
  close(): Promise<void>;
}

export async function startFaultApi(): Promise<FaultApi> {
  let status = 500;
  const server = createServer((request, response) => {
    // Drain the body so a large push is answered, not reset mid-upload.
    request.resume();
    request.on('end', () => {
      response.writeHead(status, { 'content-type': 'text/plain' });
      response.end(String(status));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    answer(next) {
      status = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

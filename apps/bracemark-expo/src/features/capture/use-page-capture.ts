import { type RefObject, useCallback, useEffect, useMemo, useRef } from 'react';
import type { WebView, WebViewMessageEvent } from 'react-native-webview';

import { newId } from '@stxapps/expo-crypto/lib/ids';
import {
  base64ToBytes,
  type CollectedMeta,
  PAGE_CAPTURE_MESSAGE,
  PAGE_CAPTURE_PREVIEW_KEY,
  type PageCaptureRequest,
  READER_IMAGE_MAX_SOURCE_BYTES,
  type ReaderImageSource,
} from '@stxapps/shared';

import { pageCaptureScript } from './page-capture-script.generated';

// The app half of the capture screen's conversation with the page in its WebView: inject
// one request (page-capture-script.generated.ts, a bundle of web-react
// lib/webview-capture.ts), read the page's answers. The protocol, and why its nonce is
// bookkeeping rather than a defence against the page: @stxapps/shared
// reader/page-capture.ts.
//
// The rules, each silent if dropped:
//
//   - ONE REQUEST AT A TIME, and a message counts only while one is pending and only
//     with its nonce. Outside a request the screen ignores everything — the page's own
//     scripts can call `window.ReactNativeWebView.postMessage` too — and a late answer
//     to a request that timed out can't be read as the answer to the next.
//   - EVERY REQUEST ENDS. A timeout resolves it with what it has (nothing, or the
//     images so far), so a page that hangs or navigates away mid-answer never leaves a
//     button spinning.
//   - NOTHING THE PAGE SENDS IS TRUSTED. Shapes are checked here; the document, the
//     images and the preview are each validated again where they are stored
//     (expo-react store-read-mode.ts, lib/reader-images.ts, lib/device-extraction.ts).

const READ_MODE_TIMEOUT_MS = 30_000;
const META_TIMEOUT_MS = 10_000;
// The page's own deadline for its image fetches, and the wait for its last message
// beyond it — the base64 of what it collected still has to cross.
const IMAGE_DEADLINE_MS = 20_000;
const IMAGE_GRACE_MS = 10_000;
// A base64 string longer than this decodes past the ceiling on one image's bytes.
const MAX_IMAGE_BASE64_CHARS = Math.ceil((READER_IMAGE_MAX_SOURCE_BYTES * 4) / 3) + 4;

const META_FIELDS = [
  'ogTitle',
  'docTitle',
  'ogImage',
  'ogImageUrl',
  'ogImageSecure',
  'twitterImage',
  'imageSrc',
] as const satisfies readonly (keyof CollectedMeta)[];

type Message = Record<string, unknown> & { type?: unknown };

interface Pending {
  nonce: string;
  receive: (message: Message) => void;
  abandon: () => void;
}

export interface PageReadMode {
  // The page's address when it captured — what its image fetches are checked against.
  href: string;
  // The capture (`{ doc, images }`), or null when the page is not an article.
  capture: unknown;
}

export interface PageCapture {
  onMessage: (event: WebViewMessageEvent) => void;
  // Undefined when the page didn't answer.
  readMode: () => Promise<PageReadMode | undefined>;
  meta: () => Promise<{ href: string; collected: CollectedMeta } | undefined>;
  // The images the page could fetch and encode, by key; the rest are absent.
  readerImages: (
    sources: readonly ReaderImageSource[],
    capturedFrom: string,
  ) => Promise<Map<string, Uint8Array>>;
  previewImage: (url: string, capturedFrom: string) => Promise<Uint8Array | undefined>;
}

function imageBytesOf(message: Message): Uint8Array | undefined {
  const { base64 } = message;
  if (typeof base64 !== 'string' || base64 === '' || base64.length > MAX_IMAGE_BASE64_CHARS) {
    return undefined;
  }
  try {
    return base64ToBytes(base64);
  } catch {
    return undefined;
  }
}

export function usePageCapture(webview: RefObject<WebView | null>): PageCapture {
  const pending = useRef<Pending | null>(null);
  // A screen that closes mid-request settles it, so nothing waits on a page that is gone.
  useEffect(() => () => pending.current?.abandon(), []);

  // Inject one request and resolve with what `onAnswer` settles on, or `fallback()` when
  // the page doesn't finish in time. A new request abandons an earlier one.
  const ask = useCallback(
    <T>(
      build: (nonce: string) => PageCaptureRequest,
      timeoutMs: number,
      onAnswer: (message: Message, finish: (value: T) => void) => void,
      fallback: () => T,
    ): Promise<T> =>
      new Promise<T>((resolve) => {
        pending.current?.abandon();
        const view = webview.current;
        if (!view) {
          resolve(fallback());
          return;
        }
        const nonce = newId();
        let finished = false;
        // Declared before `finish`, which clears it; it can only fire after both exist.
        const timer = setTimeout(() => finish(fallback()), timeoutMs);
        const finish = (value: T) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (pending.current?.nonce === nonce) pending.current = null;
          resolve(value);
        };
        pending.current = {
          nonce,
          receive: (message) => onAnswer(message, finish),
          abandon: () => finish(fallback()),
        };
        view.injectJavaScript(pageCaptureScript(build(nonce)));
      }),
    [webview],
  );

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    const current = pending.current;
    if (!current) return;
    let message: unknown;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    if ((message as Message).nonce !== current.nonce) return;
    current.receive(message as Message);
  }, []);

  const readMode = useCallback(
    () =>
      ask<PageReadMode | undefined>(
        (nonce) => ({ kind: 'readMode', nonce }),
        READ_MODE_TIMEOUT_MS,
        (message, finish) => {
          if (message.type !== PAGE_CAPTURE_MESSAGE.readMode) return;
          if (typeof message.href !== 'string') {
            finish(undefined);
            return;
          }
          finish({ href: message.href, capture: message.doc ?? null });
        },
        () => undefined,
      ),
    [ask],
  );

  const meta = useCallback(
    () =>
      ask<{ href: string; collected: CollectedMeta } | undefined>(
        (nonce) => ({ kind: 'meta', nonce }),
        META_TIMEOUT_MS,
        (message, finish) => {
          if (message.type !== PAGE_CAPTURE_MESSAGE.meta) return;
          const raw = message.collected;
          if (typeof message.href !== 'string' || typeof raw !== 'object' || raw === null) {
            finish(undefined);
            return;
          }
          // Only the string fields `selectTitleImage` reads — a page's scripts could
          // post anything in their place.
          const collected: CollectedMeta = {};
          for (const field of META_FIELDS) {
            const value = (raw as Record<string, unknown>)[field];
            if (typeof value === 'string') collected[field] = value;
          }
          finish({ href: message.href, collected });
        },
        () => undefined,
      ),
    [ask],
  );

  const readerImages = useCallback(
    (sources: readonly ReaderImageSource[], capturedFrom: string) => {
      const wanted = new Set(sources.map((source) => source.key));
      const found = new Map<string, Uint8Array>();
      return ask<Map<string, Uint8Array>>(
        (nonce) => ({
          kind: 'readerImages',
          nonce,
          capturedFrom,
          sources: [...sources],
          deadlineMs: IMAGE_DEADLINE_MS,
        }),
        IMAGE_DEADLINE_MS + IMAGE_GRACE_MS,
        (message, finish) => {
          if (message.type === PAGE_CAPTURE_MESSAGE.imagesDone) {
            finish(found);
            return;
          }
          if (message.type !== PAGE_CAPTURE_MESSAGE.image) return;
          const { key } = message;
          if (typeof key !== 'string' || !wanted.has(key) || found.has(key)) return;
          const bytes = imageBytesOf(message);
          if (bytes) found.set(key, bytes);
        },
        () => found,
      );
    },
    [ask],
  );

  const previewImage = useCallback(
    (url: string, capturedFrom: string) => {
      let found: Uint8Array | undefined;
      return ask<Uint8Array | undefined>(
        (nonce) => ({
          kind: 'previewImage',
          nonce,
          capturedFrom,
          url,
          deadlineMs: IMAGE_DEADLINE_MS,
        }),
        IMAGE_DEADLINE_MS + IMAGE_GRACE_MS,
        (message, finish) => {
          if (message.type === PAGE_CAPTURE_MESSAGE.imagesDone) {
            finish(found);
            return;
          }
          if (message.type !== PAGE_CAPTURE_MESSAGE.image) return;
          if (message.key !== PAGE_CAPTURE_PREVIEW_KEY || found) return;
          found = imageBytesOf(message);
        },
        () => found,
      );
    },
    [ask],
  );

  return useMemo(
    () => ({ onMessage, readMode, meta, readerImages, previewImage }),
    [onMessage, readMode, meta, readerImages, previewImage],
  );
}

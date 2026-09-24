import type { FileContent } from './types.js';

/** Base64 without depending on Node's `Buffer`, so the SDK runs anywhere `fetch` does. */
export function toBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString('base64');
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Turns file content into one wire operation. A string goes as text; bytes
 * go as base64, so binary content survives JSON untouched.
 */
export async function putOperation(
  path: string,
  content: FileContent,
): Promise<{ op: 'put' | 'put_base64'; path: string; content: string }> {
  if (typeof content === 'string') return { op: 'put', path, content };
  let bytes: Uint8Array;
  if (content instanceof Uint8Array) bytes = content;
  else if (content instanceof ArrayBuffer) bytes = new Uint8Array(content);
  else if (typeof Blob !== 'undefined' && content instanceof Blob) {
    bytes = new Uint8Array(await content.arrayBuffer());
  } else {
    throw new TypeError(`unsupported content for ${path}: pass a string, Uint8Array, ArrayBuffer or Blob`);
  }
  return { op: 'put_base64', path, content: toBase64(bytes) };
}

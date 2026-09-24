/** Header that carries a delivery's signature: `sha256=<hex hmac of the body>`. */
export const SIGNATURE_HEADER = 'X-Weft-Signature-256';

/** A webhook delivery, as Weft sends it. */
export type WebhookEvent =
  | {
      event: 'push';
      repo_id: string;
      /**
       * How the push arrived. Only `via: "api"` (a commit made over REST)
       * carries `commit` and `branch`; a `git push` over HTTPS or SSH says
       * only that something moved — fetch to find out what.
       */
      payload:
        | { via: 'api'; commit: string; branch: string; forwarded?: boolean }
        | { via: 'git' | 'ssh' };
    }
  | {
      event: 'change.landed';
      repo_id: string;
      payload: { change: string; commit: string; branch: string; patchset?: number; included_in?: string };
    }
  | { event: 'change.ejected'; repo_id: string; payload: { change: string; verdict: unknown } }
  | { event: string; repo_id: string; payload: Record<string, unknown> };

export interface VerifyWebhookOptions {
  /** The raw request body, exactly as received — not re-serialized JSON. */
  payload: string | Uint8Array;
  /** The `X-Weft-Signature-256` header. */
  signature: string | null | undefined;
  /** The secret returned when the webhook was created. */
  secret: string;
}

function toBytes(v: string | Uint8Array): Uint8Array {
  return typeof v === 'string' ? new TextEncoder().encode(v) : v;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Checks a delivery's signature and, if it is genuine, returns the parsed
 * event. Returns `null` for anything unsigned, mis-signed or malformed —
 * answer those with a `401` and do not act on them.
 *
 * Uses Web Crypto, so it runs in Node 20+, Deno, Bun and edge runtimes.
 *
 * ```ts
 * const event = await verifyWebhook({
 *   payload: await request.text(),
 *   signature: request.headers.get('x-weft-signature-256'),
 *   secret: process.env.WEFT_WEBHOOK_SECRET!,
 * });
 * if (!event) return new Response('bad signature', { status: 401 });
 * ```
 */
export async function verifyWebhook(options: VerifyWebhookOptions): Promise<WebhookEvent | null> {
  const { signature, secret } = options;
  if (!signature || !secret) return null;
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(signature.trim());
  if (!match) return null;

  const body = toBytes(options.payload);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('verifyWebhook needs Web Crypto (globalThis.crypto.subtle)');
  const key = await subtle.importKey(
    'raw',
    toBytes(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = hex(await subtle.sign('HMAC', key, body as BufferSource));
  if (!constantTimeEqual(expected, match[1]!.toLowerCase())) return null;

  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    if (!parsed || typeof parsed.event !== 'string') return null;
    return parsed as WebhookEvent;
  } catch {
    return null;
  }
}

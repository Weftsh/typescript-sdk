import { WeftConflictError, WeftError } from './errors.js';
import { VERSION } from './version.js';

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  /** Statuses that are an answer rather than an error, e.g. `304`. */
  allow?: number[];
  signal?: AbortSignal;
}

/** Percent-encodes each segment of a slash-separated path, keeping the slashes. */
export function encodePath(path: string): string {
  return path
    .split('/')
    .filter((s) => s !== '')
    .map(encodeURIComponent)
    .join('/');
}

export class Http {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof globalThis.fetch,
  ) {}

  url(path: string, query?: Query): string {
    const url = new URL(path, this.baseUrl + '/');
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === false) continue;
      url.searchParams.set(k, v === true ? '1' : String(v));
    }
    return url.toString();
  }

  /** Sends a request and returns the raw `Response`, throwing on a non-2xx status. */
  async raw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = this.url(path, options.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      ...options.headers,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    if (typeof process !== 'undefined' && process.versions?.node) {
      headers['User-Agent'] = `weft-typescript-sdk/${VERSION}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method, headers, body, signal: options.signal });
    } catch (cause) {
      const error = new WeftError({
        message: `${method} ${url} failed: ${(cause as Error)?.message ?? String(cause)}`,
        status: 0,
        method,
        url,
      });
      (error as { cause?: unknown }).cause = cause;
      throw error;
    }

    if (response.ok || options.allow?.includes(response.status)) return response;

    const text = await response.text().catch(() => '');
    let parsed: unknown = text || undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // not JSON; keep the text
    }
    const serverMessage =
      parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : undefined;
    const params = {
      message: serverMessage ?? `${method} ${new URL(url).pathname} answered ${response.status}`,
      status: response.status,
      method,
      url,
      body: parsed,
    };
    throw response.status === 409 ? new WeftConflictError(params) : new WeftError(params);
  }

  /** Sends a request and parses a JSON answer; `undefined` for an empty body (204). */
  async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.raw(method, path, options);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

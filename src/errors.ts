/**
 * Every failed request throws a `WeftError`. Weft answers errors as JSON
 * `{ "error": "…" }` with a matching status, and that sentence is the
 * error's `message` — it is written to be shown to a person.
 */
export class WeftError extends Error {
  /** HTTP status, e.g. `404`. `0` when the request never got an answer. */
  readonly status: number;
  /** The HTTP method of the failed request. */
  readonly method: string;
  /** The URL of the failed request. */
  readonly url: string;
  /** The parsed response body, when there was one. */
  readonly body: unknown;

  constructor(params: {
    message: string;
    status: number;
    method: string;
    url: string;
    body?: unknown;
  }) {
    super(params.message);
    this.name = 'WeftError';
    this.status = params.status;
    this.method = params.method;
    this.url = params.url;
    this.body = params.body;
  }
}

/**
 * A `409` from an optimistic-concurrency check: the branch was not where
 * you said it was (`expectedParent` on a commit, `expectedHead` on a reset
 * or revert). `currentTip` is where it actually is — rebase onto it and
 * retry.
 */
export class WeftConflictError extends WeftError {
  /** The branch's current tip, when the server reported one. */
  readonly currentTip: string | null;

  constructor(params: ConstructorParameters<typeof WeftError>[0]) {
    super(params);
    this.name = 'WeftConflictError';
    const body = params.body as Record<string, unknown> | undefined;
    const tip = body?.['current_tip'] ?? body?.['current'];
    this.currentTip = typeof tip === 'string' ? tip : null;
  }
}

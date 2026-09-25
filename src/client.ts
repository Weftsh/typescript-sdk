import { Http } from './http.js';
import { Repo, repoInfoFromWire, type RepoContext } from './repo.js';
import type {
  BatchResult,
  CreatedToken,
  CreateMirrorOptions,
  CreateRepoOptions,
  CreateTokenOptions,
  ListReposOptions,
  ListReposResult,
  RepoInfo,
  TokenInfo,
  WeftOptions,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://api.weft.sh';

type Wire = Record<string, any>;

function uniqueName(): string {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `repo-${id}`;
}

function createBody(options: CreateRepoOptions & { name: string }): Wire {
  const body: Wire = { name: options.name };
  if (options.public !== undefined) body.public = options.public;
  if (options.defaultBranch !== undefined) body.default_branch = options.defaultBranch;
  if (options.description !== undefined) body.description = options.description;
  return body;
}

function tokenFromWire(w: Wire): TokenInfo {
  return {
    id: w.id,
    label: w.label ?? null,
    scopes: w.scopes,
    repoId: w.repo_id ?? null,
    userId: w.user_id ?? null,
    createdAt: w.created_at,
    revokedAt: w.revoked_at ?? null,
    expiresAt: w.expires_at ?? null,
  };
}

/**
 * The Weft client. One per token and organization.
 *
 * ```ts
 * import { Weft } from '@weftsh/sdk';
 *
 * const weft = new Weft({ token: process.env.WEFT_TOKEN!, org: 'acme' });
 * const repo = await weft.createRepo();
 * ```
 */
export class Weft {
  /** The organization this client works in. */
  readonly org: string;
  private readonly http: Http;
  private readonly ctx: RepoContext;

  constructor(options: WeftOptions) {
    if (!options || typeof options.token !== 'string' || options.token.trim() === '') {
      throw new TypeError('Weft: `token` must be a non-empty string (a weft_… API token)');
    }
    if (typeof options.org !== 'string' || options.org.trim() === '') {
      throw new TypeError('Weft: `org` must be a non-empty string (your organization or namespace)');
    }
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetchImpl) {
      throw new TypeError('Weft: no global fetch; pass `fetch` (Node 20+ has one built in)');
    }
    this.org = options.org;
    this.http = new Http((options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''), options.token, fetchImpl);
    this.ctx = {
      http: this.http,
      org: this.org,
      createToken: (o, org) => this.mintToken(org, o),
    };
  }

  private orgPath(suffix: string, org = this.org): string {
    return `v1/orgs/${encodeURIComponent(org)}${suffix}`;
  }

  // ----------------------------------------------------------------- repos

  /**
   * Creates a repository — a real git remote, typically in under 100 ms.
   * With no `name`, one is generated.
   */
  async createRepo(options: CreateRepoOptions = {}): Promise<Repo> {
    const name = options.name ?? uniqueName();
    const w = await this.http.json<Wire>('POST', this.orgPath('/repos'), {
      body: createBody({ ...options, name }),
    });
    const info = repoInfoFromWire(w);
    return new Repo(this.ctx, info.name, info);
  }

  /** Looks a repository up by name. Resolves to `null` if there is none you can see. */
  async findOne(options: { name: string }): Promise<Repo | null> {
    const repo = this.repo(options.name);
    try {
      await repo.refresh();
      return repo;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }

  /**
   * A handle on a repository you already know exists. Makes no request;
   * the first call on it is the first request. Pass `info` if you have it
   * cached so `repo.info` is populated.
   */
  repo(name: string, info?: RepoInfo): Repo {
    return new Repo(this.ctx, name, info);
  }

  /** Lists repositories, one page at a time. Fleets of millions page fine. */
  async listRepos(options: ListReposOptions = {}): Promise<ListReposResult> {
    const w = await this.http.json<Wire>('GET', this.orgPath('/repos'), {
      query: { limit: options.limit, after: options.cursor },
    });
    return {
      repos: (w.repos as Wire[]).map((r) => {
        const info = repoInfoFromWire(r);
        return new Repo(this.ctx, info.name, info);
      }),
      nextCursor: w.next_after ?? null,
    };
  }

  /** Every repository in the organization, fetching pages as you iterate. */
  async *iterateRepos(options: { pageSize?: number } = {}): AsyncGenerator<Repo> {
    let cursor: string | undefined;
    do {
      const page = await this.listRepos({ limit: options.pageSize, cursor });
      yield* page.repos;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  /** Deletes a repository by name. */
  async deleteRepo(name: string): Promise<void> {
    await this.repo(name).delete();
  }

  /**
   * Creates up to 1,000 repositories in one call. One failing does not
   * stop the rest: check `ok` on each result, which come back in request
   * order.
   */
  async createRepos(repos: CreateRepoOptions[]): Promise<BatchResult[]> {
    const body = { repos: repos.map((r) => createBody({ ...r, name: r.name ?? uniqueName() })) };
    const w = await this.http.json<Wire>('POST', this.orgPath('/repos/batch/create'), { body });
    return (w.results as Wire[]).map(batchFromWire);
  }

  /** Deletes up to 1,000 repositories by name. */
  async deleteRepos(names: string[]): Promise<BatchResult[]> {
    const w = await this.http.json<Wire>('POST', this.orgPath('/repos/batch/delete'), { body: { names } });
    return (w.results as Wire[]).map(batchFromWire);
  }

  /**
   * Mirrors a repository from GitHub or any git host. The first sync runs
   * in the background; the mirror's `info.lastSyncAt` is set once it lands.
   */
  async createMirror(options: CreateMirrorOptions): Promise<Repo> {
    const body: Wire = { name: options.name, origin: options.origin };
    if (options.provider !== undefined) body.provider = options.provider;
    if (options.installationId !== undefined) body.installation_id = options.installationId;
    if (options.public !== undefined) body.public = options.public;
    const w = await this.http.json<Wire>('POST', this.orgPath('/mirrors'), { body });
    const info = repoInfoFromWire({ ...w.repo, org: this.org, clone_url: w.clone_url });
    return new Repo(this.ctx, info.name, info);
  }

  // ---------------------------------------------------------------- tokens

  /**
   * Mints an API token. The secret is in the result and nowhere else,
   * ever. Pass `repo` to restrict it to one repository and `ttl` to make
   * it die on its own.
   */
  createToken(options: CreateTokenOptions): Promise<CreatedToken> {
    return this.mintToken(this.org, options);
  }

  private async mintToken(org: string, options: CreateTokenOptions): Promise<CreatedToken> {
    const body: Wire = { scopes: options.scopes };
    if (options.repo !== undefined) body.repo = options.repo;
    if (options.label !== undefined) body.label = options.label;
    if (options.ttl !== undefined) body.expires_in_secs = Math.ceil(options.ttl);
    const w = await this.http.json<Wire>('POST', this.orgPath('/tokens', org), { body });
    return { id: w.id, token: w.token, expiresAt: w.expires_at ?? null };
  }

  /** Tokens, without their secrets: every token for an admin, your own for a member. */
  async listTokens(): Promise<TokenInfo[]> {
    const w = await this.http.json<Wire>('GET', this.orgPath('/tokens'));
    return (w.tokens as Wire[]).map(tokenFromWire);
  }

  /** Revokes a token. It stops working on the next request. */
  async revokeToken(id: string): Promise<void> {
    await this.http.json('DELETE', this.orgPath(`/tokens/${encodeURIComponent(id)}`));
  }
}

function batchFromWire(w: Wire): BatchResult {
  return { name: w.name, ok: w.ok, id: w.id ?? null, error: w.error ?? null };
}

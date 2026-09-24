import { CommitBuilder } from './commit.js';
import { WeftError } from './errors.js';
import { putOperation } from './encoding.js';
import { encodePath, type Http } from './http.js';
import type {
  CommitEntry,
  CommitOperation,
  CommitOptions,
  CommitResult,
  CreatedWebhook,
  CreateTokenOptions,
  CreatedToken,
  DiffResult,
  ExportJob,
  FileResult,
  GetDiffOptions,
  GetFileOptions,
  GetRemoteURLOptions,
  GetTreeOptions,
  ListCommitsOptions,
  ListCommitsResult,
  ListFilesOptions,
  ListFilesResult,
  ListRefsResult,
  Ref,
  RepoInfo,
  ResetOptions,
  RevertOptions,
  TreeResult,
  UpdateRepoOptions,
  WebhookSubscription,
} from './types.js';

/** @internal What the SDK needs from its owning client. */
export interface RepoContext {
  http: Http;
  org: string;
  /** Mints a token in `org`, which may differ from the client's (a fork elsewhere). */
  createToken(options: CreateTokenOptions, org: string): Promise<CreatedToken>;
}

type Wire = Record<string, any>;

/** @internal */
export function repoInfoFromWire(w: Wire): RepoInfo {
  return {
    id: w.id,
    org: w.org,
    orgId: w.org_id,
    name: w.name,
    description: w.description ?? null,
    homepage: w.homepage ?? null,
    kind: w.kind,
    public: w.public,
    defaultBranch: w.default_branch,
    cloneUrl: w.clone_url,
    sshCloneUrl: w.ssh_clone_url ?? null,
    storedBytes: w.stored_bytes ?? 0,
    createdAt: w.created_at,
    originUrl: w.origin_url ?? null,
    lastSyncAt: w.last_sync_at ?? null,
    lastSyncedCommit: w.last_synced_commit ?? null,
    syncError: w.sync_error ?? null,
    forkState: w.fork_state ?? null,
    forkParent: w.fork_parent ?? null,
    forkCount: w.fork_count ?? 0,
  };
}

/**
 * A 404 about something *inside* a repository — a path or a revision —
 * rather than about the repository. The server tells them apart by shape:
 * inside, a JSON `{ "error": … }` naming what was missing; the repository
 * itself, a bare `not found` that says nothing about whether it exists.
 */
function isMissingInRepo(e: unknown): boolean {
  if (!(e instanceof WeftError) || e.status !== 404) return false;
  const body = e.body as { error?: unknown } | undefined;
  return typeof body === 'object' && body !== null && typeof body.error === 'string';
}

function refFromWire(w: Wire): Ref {
  return { name: w.name, full: w.full, oid: w.oid, default: w.default };
}

/**
 * One repository. Get one from {@link Weft.createRepo}, {@link Weft.findOne}
 * or — with no request at all — {@link Weft.repo}.
 */
export class Repo {
  /** The repository's name, e.g. `"session-8412"`. */
  readonly name: string;
  /** The namespace it lives in, e.g. `"acme"`. */
  readonly org: string;
  private _info: RepoInfo | undefined;

  /** @internal */
  constructor(
    private readonly ctx: RepoContext,
    name: string,
    info?: RepoInfo,
  ) {
    this.name = name;
    this.org = info?.org ?? ctx.org;
    this._info = info;
  }

  /**
   * What the API last said about this repository, or `undefined` for a
   * repository made with {@link Weft.repo} and not yet fetched. Call
   * {@link Repo.refresh} to load or update it.
   */
  get info(): RepoInfo | undefined {
    return this._info;
  }

  /** The repository's id, when known. */
  get id(): string | undefined {
    return this._info?.id;
  }

  /** The default branch, when known. */
  get defaultBranch(): string | undefined {
    return this._info?.defaultBranch;
  }

  /** The HTTPS git remote without credentials. */
  get cloneUrl(): string {
    return this._info?.cloneUrl ?? `${this.ctx.http.baseUrl}/${this.org}/${this.name}.git`;
  }

  private path(suffix = ''): string {
    return `v1/orgs/${encodeURIComponent(this.org)}/repos/${encodeURIComponent(this.name)}${suffix}`;
  }

  // ---------------------------------------------------------------- metadata

  /** Fetches the repository's current metadata and returns it. */
  async refresh(): Promise<RepoInfo> {
    this._info = repoInfoFromWire(await this.ctx.http.json<Wire>('GET', this.path()));
    return this._info;
  }

  /** Edits the description, homepage, visibility or default branch. */
  async update(options: UpdateRepoOptions): Promise<RepoInfo> {
    const body: Wire = {};
    if (options.description !== undefined) body.description = options.description;
    if (options.homepage !== undefined) body.homepage = options.homepage;
    if (options.public !== undefined) body.public = options.public;
    if (options.defaultBranch !== undefined) body.default_branch = options.defaultBranch;
    this._info = repoInfoFromWire(await this.ctx.http.json<Wire>('PATCH', this.path(), { body }));
    return this._info;
  }

  /**
   * Deletes the repository. Instant: the name is free again at once and the
   * storage is swept later. Forks survive.
   */
  async delete(): Promise<void> {
    await this.ctx.http.json('DELETE', this.path());
  }

  /**
   * Forks this repository. The fork shares storage until the histories
   * diverge; it is readable once `info.forkState` is `ready`. Needs a
   * token that acts for a person — a service token cannot own a fork.
   */
  async fork(options: { org?: string; name?: string } = {}): Promise<Repo> {
    const w = await this.ctx.http.json<Wire>('POST', this.path('/forks'), { body: options });
    const info = repoInfoFromWire(w);
    return new Repo({ ...this.ctx, org: info.org }, info.name, info);
  }

  // ------------------------------------------------------------------- git

  /**
   * A git remote URL with a fresh, repository-scoped credential in it:
   * `https://x:weft_…@api.weft.sh/acme/session-8412.git`.
   *
   * Every call mints a new token restricted to this one repository, so you
   * can hand the URL to a sandbox or a `git clone` without handing over the
   * token the client holds. It expires after `ttl` seconds (one hour by
   * default).
   */
  async getRemoteURL(options: GetRemoteURLOptions = {}): Promise<string> {
    const minted = await this.ctx.createToken({
      scopes: [options.access === 'read' ? 'repo:read' : 'repo:write'],
      repo: this.name,
      label: options.label ?? `remote:${this.name}`,
      ttl: options.ttl ?? 3600,
    }, this.org);
    const url = new URL(this.cloneUrl);
    url.username = 'x';
    url.password = minted.token;
    return url.toString();
  }

  // --------------------------------------------------------------- writing

  /**
   * Starts a commit. Add changes with `.put()` and `.delete()`, then
   * `.send()`. No checkout, no clone — the tree is built server-side.
   */
  createCommit(options: CommitOptions): CommitBuilder {
    return new CommitBuilder(options, (o, ops) => this.commit({ ...o, operations: ops }));
  }

  /** Makes a commit from a list of operations in one call. */
  async commit(options: CommitOptions & { operations: CommitOperation[] }): Promise<CommitResult> {
    if (options.operations.length === 0) {
      throw new TypeError('a commit needs at least one operation');
    }
    const operations = await Promise.all(
      options.operations.map((op) =>
        op.op === 'delete' ? { op: 'delete' as const, path: op.path } : putOperation(op.path, op.content),
      ),
    );
    const body: Wire = { message: options.message, operations };
    if (options.branch !== undefined) body.branch = options.branch;
    if (options.author !== undefined) body.author = options.author;
    if (options.expectedParent !== undefined) body.expected_parent = options.expectedParent;
    if (options.context !== undefined) body.context = options.context;
    const w = await this.ctx.http.json<Wire>('POST', this.path('/commits'), { body, signal: options.signal });
    return { commit: w.commit, tree: w.tree, parent: w.parent ?? null, branch: w.branch };
  }

  // --------------------------------------------------------------- reading

  /**
   * Reads a file at any revision. Returns `null` when the path does not
   * exist at that revision, or the revision does not exist. A repository
   * that does not exist (or that you cannot see) throws a 404 `WeftError`.
   */
  async getFile(path: string, options: GetFileOptions = {}): Promise<FileResult | null> {
    let response: Response;
    try {
      response = await this.getFileStream(path, options);
    } catch (e) {
      if (isMissingInRepo(e)) return null;
      throw e;
    }
    const notModified = response.status === 304;
    const bytes = notModified ? new Uint8Array() : new Uint8Array(await response.arrayBuffer());
    const h = response.headers;
    return {
      notModified,
      bytes,
      etag: h.get('etag') ?? options.ifNoneMatch ?? '',
      commit: h.get('x-weft-commit'),
      mode: h.get('x-weft-mode'),
      binary: h.get('x-weft-binary') === 'true',
      contentType: h.get('content-type'),
      text: () => new TextDecoder().decode(bytes),
    };
  }

  /** Reads a file as UTF-8 text, or `null` when it does not exist at that revision. See {@link Repo.getFile}. */
  async readFile(path: string, options: Omit<GetFileOptions, 'ifNoneMatch'> = {}): Promise<string | null> {
    const file = await this.getFile(path, options);
    return file ? file.text() : null;
  }

  /**
   * Reads a file as a raw `Response`, for streaming a large one. Throws a
   * `WeftError` with status 404 when it does not exist; answers 304 when
   * `ifNoneMatch` matched.
   */
  getFileStream(path: string, options: GetFileOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: '*/*' };
    if (options.ifNoneMatch) headers['If-None-Match'] = options.ifNoneMatch;
    return this.ctx.http.raw('GET', this.path(`/files/${encodePath(path)}`), {
      query: { at: options.ref },
      headers,
      allow: [304],
      signal: options.signal,
    });
  }

  /** Lists one directory: names, modes, kinds and object ids. */
  async getTree(options: GetTreeOptions = {}): Promise<TreeResult> {
    const dir = options.path ? `/tree/${encodePath(options.path)}` : '/tree';
    const w = await this.ctx.http.json<Wire>('GET', this.path(dir), {
      query: { at: options.ref, sizes: options.sizes, history: options.history },
      signal: options.signal,
    });
    const result: TreeResult = {
      commit: w.commit,
      entries: (w.entries as Wire[]).map((e) => ({
        name: e.name,
        mode: e.mode,
        kind: e.kind,
        oid: e.oid,
        size: e.size ?? null,
        lastCommit: e.last_commit
          ? { sha: e.last_commit.commit, message: e.last_commit.message, author: e.last_commit.author }
          : null,
      })),
    };
    if (typeof w.history_truncated === 'boolean') result.historyTruncated = w.history_truncated;
    return result;
  }

  /** Lists every path under a directory, flat, in one request. */
  async listFiles(options: ListFilesOptions = {}): Promise<ListFilesResult> {
    const dir = options.path ? `/tree/${encodePath(options.path)}` : '/tree';
    const w = await this.ctx.http.json<Wire>('GET', this.path(dir), {
      query: { at: options.ref, recursive: true },
      signal: options.signal,
    });
    return { commit: w.commit, paths: w.paths, truncated: w.truncated };
  }

  /**
   * First-parent history, newest first, one page at a time. With `path`,
   * only the commits that changed it.
   */
  async listCommits(options: ListCommitsOptions = {}): Promise<ListCommitsResult> {
    const w = await this.ctx.http.json<Wire>('GET', this.path('/log'), {
      query: { rev: options.ref, path: options.path, limit: options.limit, after: options.cursor },
      signal: options.signal,
    });
    return {
      commits: (w.entries as Wire[]).map((e) => {
        const entry: CommitEntry = {
          sha: e.commit,
          tree: e.tree,
          parents: e.parents,
          author: e.author,
          committer: e.committer,
          message: e.message,
        };
        if (e.change) entry.change = e.change;
        return entry;
      }),
      nextCursor: w.next_after ?? null,
    };
  }

  /** Every file that differs between two revisions. */
  async getDiff(options: GetDiffOptions): Promise<DiffResult> {
    const w = await this.ctx.http.json<Wire>('GET', this.path('/diff'), {
      query: { from: options.from, to: options.to },
      signal: options.signal,
    });
    return {
      from: w.from,
      to: w.to,
      changes: (w.changes as Wire[]).map((c) => ({
        status: c.status,
        path: c.path,
        oldOid: c.old_oid ?? null,
        newOid: c.new_oid ?? null,
        oldMode: c.old_mode ?? null,
        newMode: c.new_mode ?? null,
      })),
    };
  }

  // ------------------------------------------------------------------ refs

  /** Every branch and tag at once. */
  async listRefs(): Promise<ListRefsResult> {
    const w = await this.ctx.http.json<Wire>('GET', this.path('/refs'));
    return { head: w.head ?? null, refs: w.refs };
  }

  /** Branches, sorted, with the default marked. */
  async listBranches(): Promise<Ref[]> {
    const w = await this.ctx.http.json<Wire>('GET', this.path('/branches'));
    return (w.branches as Wire[]).map(refFromWire);
  }

  /** Creates a branch at a revision. Returns the commit it points at. */
  async createBranch(options: { name: string; from: string }): Promise<{ oid: string }> {
    const w = await this.ctx.http.json<Wire>('POST', this.path('/branches'), { body: options });
    return { oid: w.oid };
  }

  /** Deletes a branch. */
  async deleteBranch(name: string): Promise<void> {
    await this.ctx.http.json('DELETE', this.path(`/branches/${encodeURIComponent(name)}`));
  }

  /** Tags, sorted. */
  async listTags(): Promise<Ref[]> {
    const w = await this.ctx.http.json<Wire>('GET', this.path('/tags'));
    return (w.tags as Wire[]).map(refFromWire);
  }

  /** Creates a lightweight tag at a revision. */
  async createTag(options: { name: string; target: string }): Promise<{ oid: string }> {
    const w = await this.ctx.http.json<Wire>('POST', this.path('/tags'), { body: options });
    return { oid: w.oid };
  }

  /** Deletes a tag. */
  async deleteTag(name: string): Promise<void> {
    await this.ctx.http.json('DELETE', this.path(`/tags/${encodeURIComponent(name)}`));
  }

  // ------------------------------------------------------------------ undo

  /**
   * Moves a branch to another commit — the undo primitive. Commits left
   * behind stay reachable by SHA until garbage collection, so nothing is
   * erased from the record.
   */
  async reset(options: ResetOptions): Promise<{ oid: string }> {
    const body: Wire = { to: options.to };
    if (options.branch !== undefined) body.branch = options.branch;
    if (options.expectedHead !== undefined) body.expected_head = options.expectedHead;
    const w = await this.ctx.http.json<Wire>('POST', this.path('/reset'), { body });
    return { oid: w.oid };
  }

  /** Appends a commit that undoes the branch's head commit, keeping history. */
  async revert(options: RevertOptions = {}): Promise<{ commit: string }> {
    const body: Wire = {};
    if (options.branch !== undefined) body.branch = options.branch;
    if (options.expectedHead !== undefined) body.expected_head = options.expectedHead;
    const w = await this.ctx.http.json<Wire>('POST', this.path('/revert'), { body });
    return { commit: w.commit };
  }

  // -------------------------------------------------------------- webhooks

  /**
   * Subscribes a URL to this repository's events (`push`, `change.landed`,
   * `change.ejected`). Deliveries are signed with the returned secret;
   * check them with {@link verifyWebhook}.
   */
  async createWebhook(options: { url: string }): Promise<CreatedWebhook> {
    const w = await this.ctx.http.json<Wire>('POST', this.path('/webhooks'), { body: options });
    return { id: w.id, url: w.url, secret: w.secret };
  }

  async listWebhooks(): Promise<WebhookSubscription[]> {
    const w = await this.ctx.http.json<Wire>('GET', this.path('/webhooks'));
    return (w.subscriptions as Wire[]).map((s) => ({ id: s.id, url: s.url, createdAt: s.created_at }));
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.ctx.http.json('DELETE', this.path(`/webhooks/${encodeURIComponent(id)}`));
  }

  // ---------------------------------------------------------------- export

  /** Starts exporting the repository as a standard git bundle. Poll with {@link Repo.getExport}. */
  async startExport(): Promise<ExportJob> {
    const w = await this.ctx.http.json<Wire>('POST', this.path('/export'));
    return { job: w.job, state: w.state, error: null, download: null };
  }

  async getExport(job: string): Promise<ExportJob> {
    const w = await this.ctx.http.json<Wire>('GET', this.path(`/export/${encodeURIComponent(job)}`));
    return { job: w.job, state: w.state, error: w.error ?? null, download: w.download ?? null };
  }

  /** Downloads a finished export's bundle as a streaming `Response`. `git clone bundle.git` reads it. */
  downloadExport(job: string): Promise<Response> {
    return this.ctx.http.raw('GET', this.path(`/export/${encodeURIComponent(job)}/download`), {
      headers: { Accept: 'application/octet-stream' },
    });
  }
}

/** Options for {@link Weft}. */
export interface WeftOptions {
  /**
   * A Weft API token, `weft_<id>_<secret>`. Mint one in the dashboard
   * under **Settings → Tokens**, or with {@link Weft.createToken}.
   */
  token: string;
  /** The organization (or personal namespace) the client works in, e.g. `"acme"`. */
  org: string;
  /** API origin. Defaults to `https://api.weft.sh`. */
  baseUrl?: string;
  /**
   * A `fetch` implementation to use for every request. Defaults to
   * `globalThis.fetch`. Wrap it to add retries, logging or a proxy — the
   * SDK itself never retries, because a write that failed on the way back
   * may still have happened.
   */
  fetch?: typeof globalThis.fetch;
}

/** What a repository is, as the API reports it. Timestamps are epoch milliseconds. */
export interface RepoInfo {
  id: string;
  /** The namespace this repository lives in, e.g. `"acme"`. */
  org: string;
  orgId: string;
  name: string;
  description: string | null;
  homepage: string | null;
  /** `native` for a repository written here, `mirror` for one that follows an origin. */
  kind: 'native' | 'mirror';
  public: boolean;
  defaultBranch: string;
  /** HTTPS git remote, without credentials. */
  cloneUrl: string;
  /** SSH git remote, or `null` when the deployment has no SSH front door. */
  sshCloneUrl: string | null;
  /** Bytes this repository holds in the object store. */
  storedBytes: number;
  createdAt: number;
  /** For a mirror: the origin it follows. `null` for a native repository. */
  originUrl: string | null;
  lastSyncAt: number | null;
  lastSyncedCommit: string | null;
  syncError: string | null;
  /** `pending`, `ready` or `failed` for a fork; `null` for a repository that is not one. */
  forkState: string | null;
  /** `owner/name` this was forked from, when you may see it. */
  forkParent: string | null;
  forkCount: number;
}

/** Options for {@link Weft.createRepo}. */
export interface CreateRepoOptions {
  /**
   * Letters, digits, `-`, `_` and `.`, up to 100 characters. Omit it and
   * the SDK generates a unique name — the usual choice for a repository
   * per session.
   */
  name?: string;
  /** Defaults to `false`. Private repositories live in an organization. */
  public?: boolean;
  /** Defaults to `"main"`. */
  defaultBranch?: string;
  /** One line about the repository, up to 512 characters. */
  description?: string;
}

/** Options for {@link Repo.update}. Absent fields are left alone; `null` clears. */
export interface UpdateRepoOptions {
  description?: string | null;
  /** An absolute `http://` or `https://` URL, or `null` to clear. */
  homepage?: string | null;
  /** Needs `org:admin`. */
  public?: boolean;
  /** Needs `org:admin`; the branch must already exist. */
  defaultBranch?: string;
}

export interface ListReposOptions {
  /** Up to 1000; defaults to 100. */
  limit?: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
}

export interface ListReposResult {
  repos: import('./repo.js').Repo[];
  /** Pass as `cursor` for the next page; `null` on the last one. */
  nextCursor: string | null;
}

/** One item of a batch create or delete, in request order. */
export interface BatchResult {
  name: string;
  ok: boolean;
  id: string | null;
  error: string | null;
}

/** A commit author or committer. */
export interface Identity {
  name: string;
  email: string;
}

/** Anything the SDK can turn into file content. Strings are sent as UTF-8. */
export type FileContent = string | Uint8Array | ArrayBuffer | Blob;

/** One tree operation of a commit. */
export type CommitOperation =
  | { op: 'put'; path: string; content: FileContent }
  | { op: 'delete'; path: string };

/** Options for {@link Repo.createCommit} and {@link Repo.commit}. */
export interface CommitOptions {
  /**
   * Defaults to `"main"` — not the repository's default branch, so pass it
   * if yours is called something else. Created if it does not exist.
   */
  branch?: string;
  message: string;
  /** Who `git log` shows. Defaults to the person or token acting. */
  author?: Identity;
  /**
   * Optimistic concurrency. A SHA: the branch must point exactly there, or
   * the commit fails with a {@link WeftConflictError} carrying the current
   * tip. `null`: the branch must not exist yet. Omit it to commit on top of
   * whatever the branch points at now.
   */
  expectedParent?: string | null;
  /**
   * Anything JSON — an agent run id, a prompt id. Recorded immutably in the
   * audit trail beside the commit and the token that made it.
   */
  context?: unknown;
  signal?: AbortSignal;
}

/** What a commit made. Durable once returned. */
export interface CommitResult {
  /** The new commit's SHA. */
  commit: string;
  /** Its tree's SHA. */
  tree: string;
  /** The commit it was made on top of; `null` for the first commit on a branch. */
  parent: string | null;
  branch: string;
}

export interface GetFileOptions {
  /** A commit SHA, branch, tag or `HEAD` (the default). */
  ref?: string;
  /**
   * An `etag` from an earlier read. If the file has not changed, the result
   * has `notModified: true` and no bytes were transferred.
   */
  ifNoneMatch?: string;
  signal?: AbortSignal;
}

/** A file read at some revision. */
export interface FileResult {
  /** `true` when `ifNoneMatch` matched: nothing changed, `bytes` is empty. */
  notModified: boolean;
  bytes: Uint8Array;
  /** The content hash (the blob SHA, quoted). Send it back as `ifNoneMatch`. */
  etag: string;
  /** The commit the content came from. */
  commit: string | null;
  /** Git file mode, e.g. `100644`. */
  mode: string | null;
  /** Whether the content looks binary (a NUL byte in the first 8 KiB). */
  binary: boolean;
  contentType: string | null;
  /** The content decoded as UTF-8. */
  text(): string;
}

export interface GetTreeOptions {
  /** A directory; the repository root when omitted. */
  path?: string;
  /** A commit SHA, branch, tag or `HEAD` (the default). */
  ref?: string;
  /** Measure every blob. Off by default, because it reads each one. */
  sizes?: boolean;
  /** Add the commit that last touched each entry (a bounded history walk). */
  history?: boolean;
  signal?: AbortSignal;
}

export interface TreeEntry {
  name: string;
  mode: string;
  kind: 'blob' | 'tree';
  oid: string;
  /** Bytes, for a blob when `sizes` was asked for; otherwise `null`. */
  size: number | null;
  /** When `history` was asked for: the last commit that touched this entry, if the walk reached it. */
  lastCommit: { sha: string; message: string; author: string } | null;
}

export interface TreeResult {
  commit: string;
  entries: TreeEntry[];
  /** With `history`: `true` when the walk ran out of budget before reaching every entry. */
  historyTruncated?: boolean;
}

export interface ListFilesOptions {
  /** A directory; the repository root when omitted. Paths come back relative to it. */
  path?: string;
  ref?: string;
  signal?: AbortSignal;
}

export interface ListFilesResult {
  commit: string;
  /** Every path under the directory, flat. Directories end in `/`. */
  paths: string[];
  /** `true` when the listing stopped at the server's cap. */
  truncated: boolean;
}

export interface ListCommitsOptions {
  /** Where to start: a SHA, branch, tag or `HEAD` (the default). */
  ref?: string;
  /** Only commits that changed this path, each with a `change`. */
  path?: string;
  /** Up to 500; defaults to 50. */
  limit?: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
  signal?: AbortSignal;
}

export interface CommitEntry {
  /** The commit's SHA. */
  sha: string;
  tree: string;
  parents: string[];
  /** Raw git ident line: `Name <email> <epoch> <tz>`. */
  author: string;
  committer: string;
  message: string;
  /** With a `path` filter: what this commit did to that path. */
  change?: 'added' | 'modified' | 'deleted';
}

export interface ListCommitsResult {
  commits: CommitEntry[];
  /** Pass as `cursor` for the next page; `null` when history is exhausted. */
  nextCursor: string | null;
}

export interface GetDiffOptions {
  /** Base revision: a SHA, branch, tag or `HEAD`. */
  from: string;
  /** Target revision. */
  to: string;
  signal?: AbortSignal;
}

export interface DiffChange {
  status: string;
  path: string;
  oldOid: string | null;
  newOid: string | null;
  oldMode: string | null;
  newMode: string | null;
}

export interface DiffResult {
  /** The resolved base commit. */
  from: string;
  /** The resolved target commit. */
  to: string;
  changes: DiffChange[];
}

export interface Ref {
  /** Short name, e.g. `main` or `v1.0.0`. */
  name: string;
  /** Full ref name, e.g. `refs/heads/main`. */
  full: string;
  oid: string;
  /** Whether this is the repository's default branch. Always `false` for a tag. */
  default: boolean;
}

export interface ListRefsResult {
  /** The ref `HEAD` points at, e.g. `refs/heads/main`. */
  head: string | null;
  /** Every branch and tag, by full name. */
  refs: { name: string; oid: string }[];
}

export interface ResetOptions {
  /** Defaults to `"main"`. */
  branch?: string;
  /** The commit to move the branch back (or forward) to. */
  to: string;
  /** The branch must currently point here, or the reset fails with a conflict. */
  expectedHead?: string;
}

export interface RevertOptions {
  /** Defaults to `"main"`. */
  branch?: string;
  /** The branch must currently point here, or the revert fails with a conflict. */
  expectedHead?: string;
}

export interface GetRemoteURLOptions {
  /** `write` (the default) can push; `read` can only clone and fetch. */
  access?: 'read' | 'write';
  /** Seconds until the embedded credential dies. Defaults to one hour; at most one year. */
  ttl?: number;
  /** A label for the minted token, shown in the token list and on its commits. */
  label?: string;
}

export interface CreateTokenOptions {
  /** `org:admin`, `org:read`, `repo:read`, `repo:write`, `repo:cache`. */
  scopes: TokenScope[];
  /** Restrict the token to one repository, by name. */
  repo?: string;
  label?: string;
  /** Seconds until the token dies on its own. Omit for one that lives until revoked. */
  ttl?: number;
}

export type TokenScope = 'org:admin' | 'org:read' | 'repo:read' | 'repo:write' | 'repo:cache';

export interface CreatedToken {
  id: string;
  /** The secret. Shown exactly once — store it now. */
  token: string;
  /** Epoch milliseconds, or `null` for a token that lives until revoked. */
  expiresAt: number | null;
}

export interface TokenInfo {
  id: string;
  label: string | null;
  scopes: TokenScope[];
  repoId: string | null;
  userId: string | null;
  createdAt: number;
  revokedAt: number | null;
  expiresAt: number | null;
}

export interface WebhookSubscription {
  id: string;
  url: string;
  createdAt: number;
}

export interface CreatedWebhook {
  id: string;
  url: string;
  /** The signing secret. Shown exactly once — store it now. */
  secret: string;
}

export interface ExportJob {
  job: string;
  /** `queued`, `running`, `done` or `failed`. */
  state: string;
  error: string | null;
  /** Where to download the bundle, once `state` is `done`. */
  download: string | null;
}

export interface CreateMirrorOptions {
  /** The mirror's name in your organization. */
  name: string;
  /** `owner/name` for GitHub, or a git URL for any other host. */
  origin: string;
  /** Defaults to `github`. */
  provider?: 'github' | 'generic';
  /** The GitHub App installation that can read a private origin. Omit for a public one. */
  installationId?: string;
  public?: boolean;
}

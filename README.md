# @weftsh/sdk

The TypeScript SDK for [Weft](https://weft.sh) — a real git repository per
user, session or agent, created in under 100 ms and written entirely over
HTTP.

```ts
import { Weft } from '@weftsh/sdk';

const weft = new Weft({ token: process.env.WEFT_TOKEN!, org: 'acme' });

const repo = await weft.createRepo();

await repo
  .createCommit({ message: 'agent step 1' })
  .put('src/app.ts', 'export const answer = 42;\n')
  .put('README.md', '# session\n')
  .send();

console.log(await repo.readFile('src/app.ts'));
console.log(await repo.getRemoteURL()); // https://x:weft_…@api.weft.sh/acme/repo-….git
```

No checkout, no clone, no disk. Every repository is still a stock git remote
you can clone, push to and export.

- Zero dependencies. Runs on Node 20+, Bun, Deno and edge runtimes — anywhere
  `fetch` and Web Crypto exist.
- ESM and CommonJS, with full type definitions.
- One method per thing you want to do, named for it.

## Contents

- [Install](#install)
- [Set up the client](#set-up-the-client)
- [Repositories](#repositories)
- [Commits](#commits)
- [Reading](#reading)
- [Branches and tags](#branches-and-tags)
- [Undo](#undo)
- [Git remotes](#git-remotes)
- [Tokens](#tokens)
- [Webhooks](#webhooks)
- [Export](#export)
- [Mirrors](#mirrors)
- [Errors](#errors)
- [Custom fetch and retries](#custom-fetch-and-retries)
- [API reference](#api-reference)

## Install

```bash
npm install @weftsh/sdk
```

## Set up the client

You need an organization and a token. [Sign up](https://weft.sh/login?mode=signup),
create an organization, and mint a token under **Settings → Tokens** (or see
[authentication](https://weft.sh/docs/authentication/)).

```ts
import { Weft } from '@weftsh/sdk';

const weft = new Weft({
  token: process.env.WEFT_TOKEN!, // weft_<id>_<secret>
  org: 'acme', // your organization, or your personal namespace
});
```

| Option    | Default                | What it is                                                |
| --------- | ---------------------- | --------------------------------------------------------- |
| `token`   | —                      | A Weft API token. Required.                               |
| `org`     | —                      | The namespace every call works in. Required.              |
| `baseUrl` | `https://api.weft.sh`  | The API origin — change it for a self-hosted deployment.  |
| `fetch`   | `globalThis.fetch`     | Your own `fetch`, for retries, logging or a proxy.        |

Keep the token on the server. To give a sandbox, a browser or a subprocess
access to one repository, hand it a [remote URL](#git-remotes) or a
[repo-scoped token](#tokens) instead.

## Repositories

```ts
// A generated name — the usual choice for one repository per session.
const repo = await weft.createRepo();

// Or choose everything.
const docs = await weft.createRepo({
  name: 'docs-site', // letters, digits, - _ . — up to 100 characters
  defaultBranch: 'main',
  public: false,
  description: 'Generated documentation',
});

repo.name; // 'repo-4f7c…'
repo.info?.cloneUrl; // 'https://api.weft.sh/acme/repo-4f7c….git'
```

Find one by name — `null` when there is none you can see:

```ts
const found = await weft.findOne({ name: 'docs-site' });
```

Or get a handle with **no request at all**, when you already know it exists:

```ts
const repo = weft.repo('session-8412');
await repo.createCommit({ message: 'resume' }).put('state.json', '{}').send();
```

List them a page at a time, or iterate over all of them:

```ts
const { repos, nextCursor } = await weft.listRepos({ limit: 100 });

for await (const repo of weft.iterateRepos()) {
  console.log(repo.name, repo.info?.storedBytes);
}
```

Fleets are one call. Up to 1,000 per request; each item reports its own
outcome, in request order:

```ts
const results = await weft.createRepos([{ name: 'agent-1' }, { name: 'agent-2' }]);
const failed = results.filter((r) => !r.ok); // [{ name, ok: false, error }]

await weft.deleteRepos(['agent-1', 'agent-2']);
```

Edit, delete, fork:

```ts
await repo.update({ description: 'Session 8412', homepage: 'https://example.com' });
await repo.update({ description: null }); // null clears

await repo.delete(); // instant; storage is swept later, forks survive

const fork = await repo.fork({ org: 'my-team', name: 'experiment' });
fork.info?.forkState; // 'pending', then 'ready'
```

A dormant repository costs storage and nothing else, so creating one per
session and keeping it is the normal pattern, not a cleanup problem.

## Commits

Build a commit from changes and send it. The tree is built server-side;
nothing is checked out anywhere.

```ts
const result = await repo
  .createCommit({
    branch: 'main', // default 'main' (whatever the repo's default is); created if missing
    message: 'agent step 12',
    author: { name: 'Build Agent', email: 'agent@acme.dev' }, // optional
    context: { run: 'r-42', prompt: 'p-991' }, // optional audit record
  })
  .put('src/app.ts', source) // string → UTF-8
  .put('assets/logo.png', pngBytes) // Uint8Array, ArrayBuffer or Blob → binary-safe
  .delete('notes.txt')
  .send();

result.commit; // the new commit's SHA
result.parent; // the commit it was made on — null for a branch's first
```

Commits are durable when `send()` resolves.

**`context`** is any JSON you like. It is written to the organization's
immutable audit trail beside the commit and the token that made it — how you
answer "what did the agent change, and why" months later.

**Concurrency.** Pass `expectedParent` with the commit you built against.
If the branch has moved, the commit is refused with a
[`WeftConflictError`](#errors) carrying the current tip:

```ts
import { WeftConflictError } from '@weftsh/sdk';

try {
  await repo.createCommit({ message: 'step 13', expectedParent: lastSeen }).put('a.txt', 'x').send();
} catch (e) {
  if (e instanceof WeftConflictError) {
    lastSeen = e.currentTip!; // rebase your change onto this and retry
  } else throw e;
}
```

| `expectedParent` | Meaning                                                   |
| ---------------- | --------------------------------------------------------- |
| omitted          | Commit on top of whatever the branch points at now.       |
| `'3f2a…'`        | The branch must point exactly here, or 409.               |
| `null`           | The branch must not exist yet — create it with this commit. |

Prefer a plain list? `repo.commit()` takes the same options plus
`operations`:

```ts
await repo.commit({
  message: 'seed',
  operations: [
    { op: 'put', path: 'a.txt', content: 'a' },
    { op: 'delete', path: 'b.txt' },
  ],
});
```

A commit holds up to 10,000 operations.

## Reading

Any file, at any revision. A revision is a full 40-character commit SHA, a
branch, a tag, a full ref name (`refs/heads/main`) or `HEAD`; git's `main~3`
and short SHAs are not understood — walk `listCommits` instead.

```ts
const text = await repo.readFile('src/app.ts'); // string, or null if absent
const old = await repo.readFile('src/app.ts', { ref: '3f2a…' });
```

`getFile` gives you the bytes and what the server knows about them:

```ts
const file = await repo.getFile('assets/logo.png');
if (file) {
  file.bytes; // Uint8Array
  file.binary; // true
  file.commit; // the commit the content came from
  file.etag; // the content hash
}
```

Cache with the ETag — an unchanged file costs a 304 and no bytes:

```ts
const again = await repo.getFile('src/app.ts', { ifNoneMatch: file.etag });
if (again?.notModified) {
  // use what you have
}
```

For large files, stream: `repo.getFileStream(path)` returns the raw `Response`.

Directories, one level at a time or all at once:

```ts
const tree = await repo.getTree({ path: 'src', ref: 'main' });
tree.entries; // [{ name, kind: 'blob' | 'tree', mode, oid, size, lastCommit }]

await repo.getTree({ sizes: true }); // measure each blob
await repo.getTree({ history: true }); // the last commit to touch each entry

const { paths } = await repo.listFiles(); // ['README.md', 'src/', 'src/app.ts', …]
```

History, newest first, a page at a time — optionally only the commits that
touched one path:

```ts
const { commits, nextCursor } = await repo.listCommits({ limit: 50 });
commits[0]; // { sha, parents, author, committer, message, tree }

const page = await repo.listCommits({ path: 'src/app.ts' });
page.commits[0].change; // 'added' | 'modified' | 'deleted'
```

Pass `nextCursor` back as `cursor` for the next page. A path-filtered request
examines at most 500 commits, so a long search is several bounded requests
rather than one unbounded scan — keep paging while `nextCursor` is set, even
when a page comes back empty.

What changed between two revisions:

```ts
const { changes } = await repo.getDiff({ from: 'v1.0.0', to: 'main' });
// [{ path, status: 'added' | 'modified' | 'deleted', oldOid, newOid, oldMode, newMode }]
```

## Branches and tags

```ts
await repo.createBranch({ name: 'feature/login', from: 'main' });
await repo.listBranches(); // [{ name, full, oid, default }]
await repo.deleteBranch('feature/login');

await repo.createTag({ name: 'v1.0.0', target: 'main' });
await repo.listTags();
await repo.deleteTag('v1.0.0');

await repo.listRefs(); // { head: 'refs/heads/main', refs: [{ name, oid }] } — everything at once
```

## Undo

Undo is a primitive, not a project.

```ts
// Put the branch back where it was before the agent went sideways.
await repo.reset({ branch: 'main', to: goodCommit, expectedHead: badCommit });

// Or append a commit that undoes the head, keeping the history.
await repo.revert({ branch: 'main' });
```

A reset never erases anything: the commits it leaves behind stay reachable by
SHA until garbage collection, so the audit trail survives the undo. Both take
`expectedHead` and fail with a `WeftConflictError` if the branch has moved.

## Git remotes

Every repository is a real git remote. `getRemoteURL()` returns one with a
**fresh credential scoped to that one repository**, so you can hand it to a
sandbox, a CI job or an agent without handing over your own token:

```ts
const url = await repo.getRemoteURL(); // write access, expires in an hour
// https://x:weft_…@api.weft.sh/acme/session-8412.git

const readOnly = await repo.getRemoteURL({ access: 'read', ttl: 600 });
```

```bash
git clone "$url" && cd session-8412
git commit -am "from a sandbox" && git push
```

| Option   | Default   | What it is                                           |
| -------- | --------- | ---------------------------------------------------- |
| `access` | `'write'` | `'write'` clones and pushes; `'read'` only clones.   |
| `ttl`    | `3600`    | Seconds until the credential dies. At most a year.   |
| `label`  | `remote:<repo>` | Shown in the token list and in the audit trail. |

Each call mints a new token, which needs a client token allowed to mint:
`org:admin` for a service token, or a personal token whose owner can write to
the repository. `repo.cloneUrl` is the same URL with no credential in it.

## Tokens

```ts
const { id, token, expiresAt } = await weft.createToken({
  scopes: ['repo:write'], // org:admin · org:read · repo:read · repo:write · repo:cache
  repo: 'session-8412', // optional: this repository only
  label: 'sandbox-8412',
  ttl: 3600, // optional: seconds until it dies on its own
});

await weft.listTokens(); // without secrets
await weft.revokeToken(id); // dead on the next request
```

The secret is in the result and nowhere else, ever — store it now.

## Webhooks

Subscribe a URL to a repository's events:

```ts
const { id, secret } = await repo.createWebhook({ url: 'https://app.example.com/hooks/weft' });
```

Verify every delivery before trusting it. `verifyWebhook` checks the
`X-Weft-Signature-256` header against the raw body and returns the parsed
event, or `null`:

```ts
import { verifyWebhook } from '@weftsh/sdk';

export async function POST(request: Request) {
  const event = await verifyWebhook({
    payload: await request.text(), // the raw body — not re-serialized JSON
    signature: request.headers.get('x-weft-signature-256'),
    secret: process.env.WEFT_WEBHOOK_SECRET!,
  });
  if (!event) return new Response('bad signature', { status: 401 });

  if (event.event === 'push') {
    // Something moved. Only commits made over REST carry `branch` and
    // `commit`; a `git push` says only that something changed — fetch to
    // find out what.
  }
  return new Response('ok');
}
```

| Event            | Fires when                                                   |
| ---------------- | ------------------------------------------------------------ |
| `push`           | Anything moves a ref: `git push` over HTTPS or SSH, or a commit made over REST |
| `change.landed`  | A change lands through the land queue                        |
| `change.ejected` | The lander refused a change                                  |

`repo.listWebhooks()` and `repo.deleteWebhook(id)` manage subscriptions.

## Export

Any repository, any time, as a standard git bundle — adopting Weft is not a
lock-in decision.

```ts
let job = await repo.startExport();
while (job.state !== 'done' && job.state !== 'failed') {
  await new Promise((r) => setTimeout(r, 500));
  job = await repo.getExport(job.job);
}
const bundle = await repo.downloadExport(job.job); // Response
```

```bash
git clone repo.bundle my-repo
```

## Mirrors

Mirror a repository from GitHub or any git host; the first sync runs in the
background.

```ts
const mirror = await weft.createMirror({ name: 'linux', origin: 'torvalds/linux', public: true });
const generic = await weft.createMirror({
  name: 'tool',
  provider: 'generic',
  origin: 'https://git.example.com/acme/tool.git',
});
```

Private GitHub origins need the Weft GitHub App — see
[the mirror quickstart](https://weft.sh/docs/quickstart-mirror/).

## Errors

Every failed request throws a `WeftError`:

```ts
import { WeftError } from '@weftsh/sdk';

try {
  await weft.createRepo({ name: 'taken' });
} catch (e) {
  if (e instanceof WeftError) {
    e.status; // 409
    e.message; // the server's own sentence, written to be shown to a person
    e.body; // the parsed response body
  }
}
```

| Class               | When                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `WeftConflictError` | `409` from a concurrency check. `currentTip` is where the branch is. Extends `WeftError`. |
| `WeftError`         | Anything else. `status` is `0` when the request never got an answer. |

Lookups that commonly miss return `null` instead of throwing: `findOne` for
a repository, and `getFile` and `readFile` for a path or revision that is not
there. A file read from a repository that does not exist still throws — a typo
in a repository name is not a missing file.

A `404` also covers "exists, but not for you" — Weft does not tell a caller
about repositories it cannot see.

## Custom fetch and retries

The SDK never retries on its own: a write that failed on the way back may
still have happened. Pass a `fetch` to decide for yourself — for example,
retrying reads once on a 503:

```ts
const retryingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status === 503 && (init?.method ?? 'GET') === 'GET') {
    await response.body?.cancel();
    return fetch(input, init);
  }
  return response;
};

const weft = new Weft({ token, org: 'acme', fetch: retryingFetch });
```

A commit with `expectedParent` set is safe to retry: if the first attempt
landed, the retry answers `409` with your own commit as `currentTip`.

Every method that reads also takes a `signal` to abort it.

## API reference

### `Weft`

| Method | Returns |
| --- | --- |
| `new Weft({ token, org, baseUrl?, fetch? })` | |
| `createRepo({ name?, public?, defaultBranch?, description? })` | `Repo` |
| `findOne({ name })` | `Repo \| null` |
| `repo(name, info?)` | `Repo` — no request |
| `listRepos({ limit?, cursor? })` | `{ repos, nextCursor }` |
| `iterateRepos({ pageSize? })` | `AsyncGenerator<Repo>` |
| `deleteRepo(name)` | `void` |
| `createRepos(options[])` | `BatchResult[]` |
| `deleteRepos(names[])` | `BatchResult[]` |
| `createMirror({ name, origin, provider?, installationId?, public? })` | `Repo` |
| `createToken({ scopes, repo?, label?, ttl? })` | `{ id, token, expiresAt }` |
| `listTokens()` | `TokenInfo[]` |
| `revokeToken(id)` | `void` |

### `Repo`

| Member | Returns |
| --- | --- |
| `name`, `org`, `id`, `defaultBranch`, `cloneUrl`, `info` | |
| `refresh()` | `RepoInfo` |
| `update({ description?, homepage?, public?, defaultBranch? })` | `RepoInfo` |
| `delete()` | `void` |
| `fork({ org?, name? })` | `Repo` |
| `getRemoteURL({ access?, ttl?, label? })` | `string` |
| `createCommit(options)` → `.put(path, content)` · `.delete(path)` · `.send()` | `CommitResult` |
| `commit({ ...options, operations })` | `CommitResult` |
| `readFile(path, { ref? })` | `string \| null` |
| `getFile(path, { ref?, ifNoneMatch? })` | `FileResult \| null` |
| `getFileStream(path, { ref?, ifNoneMatch? })` | `Response` |
| `getTree({ path?, ref?, sizes?, history? })` | `TreeResult` |
| `listFiles({ path?, ref? })` | `{ commit, paths, truncated }` |
| `listCommits({ ref?, path?, limit?, cursor? })` | `{ commits, nextCursor }` |
| `getDiff({ from, to })` | `{ from, to, changes }` |
| `listRefs()` | `{ head, refs }` |
| `listBranches()` / `listTags()` | `Ref[]` |
| `createBranch({ name, from })` / `createTag({ name, target })` | `{ oid }` |
| `deleteBranch(name)` / `deleteTag(name)` | `void` |
| `reset({ to, branch?, expectedHead? })` | `{ oid }` |
| `revert({ branch?, expectedHead? })` | `{ commit }` |
| `createWebhook({ url })` | `{ id, url, secret }` |
| `listWebhooks()` / `deleteWebhook(id)` | |
| `startExport()` / `getExport(job)` | `ExportJob` |
| `downloadExport(job)` | `Response` |

### Functions

| Function | Returns |
| --- | --- |
| `verifyWebhook({ payload, signature, secret })` | `WebhookEvent \| null` |

Everything is typed; your editor has the rest. The full REST API is described
at [weft.sh/openapi.json](https://weft.sh/openapi.json).

## Development

```bash
npm install
npm run check # typecheck, unit tests, build
```

The unit tests check what the SDK sends. The end-to-end suite checks that a
real server agrees — run it against any Weft deployment with an `org:admin`
token:

```bash
WEFT_E2E_URL=http://127.0.0.1:8080 WEFT_E2E_ORG=acme WEFT_E2E_TOKEN=weft_… npm run test:e2e
```

It creates repositories, clones and pushes with the real `git` CLI through
`getRemoteURL`, runs `git fsck --full --strict` on the clone, and deletes
everything it made.

## License

MIT

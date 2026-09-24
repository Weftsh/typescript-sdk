import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Weft, WeftConflictError, WeftError, verifyWebhook } from '../src/index.js';

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: any;
}

/** A fetch that records every call and answers from a queue of responses. */
function fakeFetch(...responses: Response[]) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const repoWire = {
  id: 'r1',
  org_id: 'o1',
  org: 'acme',
  name: 'session-1',
  description: null,
  homepage: null,
  kind: 'native',
  public: false,
  default_branch: 'main',
  clone_url: 'https://api.weft.sh/acme/session-1.git',
  ssh_clone_url: null,
  stored_bytes: 0,
  created_at: 1766000000000,
  origin_url: null,
  last_sync_at: null,
  last_synced_commit: null,
  sync_error: null,
  fork_state: null,
  fork_parent: null,
  fork_count: 0,
};

function client(...responses: Response[]) {
  const f = fakeFetch(...responses);
  return { weft: new Weft({ token: 'weft_a_b', org: 'acme', fetch: f.fetch }), calls: f.calls };
}

describe('Weft', () => {
  it('refuses to construct without a token or an org', () => {
    expect(() => new Weft({ token: '', org: 'acme' })).toThrow(/token/);
    expect(() => new Weft({ token: 'weft_a_b', org: ' ' })).toThrow(/org/);
  });

  it('creates a repository with the bearer token, snake_case body and camelCase result', async () => {
    const { weft, calls } = client(json(201, repoWire));
    const repo = await weft.createRepo({ name: 'session-1', defaultBranch: 'main', public: false });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.href).toBe('https://api.weft.sh/v1/orgs/acme/repos');
    expect(calls[0]!.headers.Authorization).toBe('Bearer weft_a_b');
    expect(calls[0]!.body).toEqual({ name: 'session-1', default_branch: 'main', public: false });
    expect(repo.name).toBe('session-1');
    expect(repo.info?.cloneUrl).toBe('https://api.weft.sh/acme/session-1.git');
    expect(repo.defaultBranch).toBe('main');
  });

  it('generates a valid repository name when none is given', async () => {
    const { weft, calls } = client(json(201, repoWire));
    await weft.createRepo();
    expect(calls[0]!.body.name).toMatch(/^repo-[A-Za-z0-9._-]+$/);
    expect(calls[0]!.body.name.length).toBeLessThanOrEqual(100);
  });

  it('findOne resolves null on 404 and rethrows anything else', async () => {
    const { weft } = client(json(404, { error: 'not found' }), json(500, { error: 'boom' }));
    expect(await weft.findOne({ name: 'nope' })).toBeNull();
    await expect(weft.findOne({ name: 'x' })).rejects.toMatchObject({ status: 500, message: 'boom' });
  });

  it('repo() makes no request', () => {
    const { weft, calls } = client();
    const repo = weft.repo('session-1');
    expect(repo.cloneUrl).toBe('https://api.weft.sh/acme/session-1.git');
    expect(calls).toHaveLength(0);
  });

  it('honours a custom baseUrl, trailing slash or not', async () => {
    const f = fakeFetch(json(200, { repos: [], next_after: null }));
    const weft = new Weft({ token: 't', org: 'acme', baseUrl: 'http://localhost:8080/', fetch: f.fetch });
    await weft.listRepos({ limit: 5 });
    expect(f.calls[0]!.url.href).toBe('http://localhost:8080/v1/orgs/acme/repos?limit=5');
  });

  it('pages through every repository', async () => {
    const { weft, calls } = client(
      json(200, { repos: [repoWire], next_after: 'r1' }),
      json(200, { repos: [{ ...repoWire, id: 'r2', name: 'session-2' }], next_after: null }),
    );
    const names: string[] = [];
    for await (const r of weft.iterateRepos({ pageSize: 1 })) names.push(r.name);
    expect(names).toEqual(['session-1', 'session-2']);
    expect(calls[1]!.url.searchParams.get('after')).toBe('r1');
  });
});

describe('commits', () => {
  it('sends text as put, bytes as put_base64, and the concurrency fields in wire names', async () => {
    const { weft, calls } = client(json(201, { commit: 'c2', tree: 't2', parent: 'c1', branch: 'main' }));
    const result = await weft
      .repo('session-1')
      .createCommit({ message: 'step', expectedParent: 'c1', context: { run: 'r-42' }, author: { name: 'A', email: 'a@x' } })
      .put('a.txt', 'hi\n')
      .put('b.bin', new Uint8Array([0, 1, 255]))
      .delete('old.txt')
      .send();
    expect(result).toEqual({ commit: 'c2', tree: 't2', parent: 'c1', branch: 'main' });
    expect(calls[0]!.url.pathname).toBe('/v1/orgs/acme/repos/session-1/commits');
    expect(calls[0]!.body).toEqual({
      message: 'step',
      expected_parent: 'c1',
      context: { run: 'r-42' },
      author: { name: 'A', email: 'a@x' },
      operations: [
        { op: 'put', path: 'a.txt', content: 'hi\n' },
        { op: 'put_base64', path: 'b.bin', content: 'AAH/' },
        { op: 'delete', path: 'old.txt' },
      ],
    });
  });

  it('sends expectedParent: null as an explicit null (branch must not exist)', async () => {
    const { weft, calls } = client(json(201, { commit: 'c1', tree: 't', parent: null, branch: 'b' }));
    await weft.repo('r').commit({ branch: 'b', message: 'm', expectedParent: null, operations: [{ op: 'delete', path: 'x' }] });
    expect(calls[0]!.body).toHaveProperty('expected_parent', null);
  });

  it('omits expected_parent entirely when not given', async () => {
    const { weft, calls } = client(json(201, { commit: 'c1', tree: 't', parent: null, branch: 'main' }));
    await weft.repo('r').createCommit({ message: 'm' }).put('a', 'b').send();
    expect(calls[0]!.body).not.toHaveProperty('expected_parent');
  });

  it('turns a 409 into a WeftConflictError carrying the current tip', async () => {
    const { weft } = client(json(409, { error: 'expected_parent does not match the current branch tip', current_tip: 'c9' }));
    const err = await weft.repo('r').createCommit({ message: 'm', expectedParent: 'c1' }).put('a', 'b').send().catch((e) => e);
    expect(err).toBeInstanceOf(WeftConflictError);
    expect(err).toBeInstanceOf(WeftError);
    expect(err.status).toBe(409);
    expect(err.currentTip).toBe('c9');
    expect(err.message).toMatch(/expected_parent/);
  });

  it('reads the reset conflict shape too', async () => {
    const { weft } = client(json(409, { error: 'precondition failed on refs/heads/main', current: 'c7' }));
    const err = await weft.repo('r').reset({ to: 'c1', expectedHead: 'c2' }).catch((e) => e);
    expect(err.currentTip).toBe('c7');
  });

  it('refuses an empty commit before sending anything', async () => {
    const { weft, calls } = client();
    await expect(weft.repo('r').createCommit({ message: 'm' }).send()).rejects.toThrow(/at least one/);
    expect(calls).toHaveLength(0);
  });
});

describe('reads', () => {
  it('reads a file with its headers, and a 304 as notModified', async () => {
    const { weft, calls } = client(
      new Response('hello\n', {
        status: 200,
        headers: { etag: '"abc"', 'x-weft-commit': 'c1', 'x-weft-mode': '100644', 'x-weft-binary': 'false', 'content-type': 'text/plain; charset=utf-8' },
      }),
      new Response(null, { status: 304, headers: { etag: '"abc"' } }),
    );
    const repo = weft.repo('r');
    const file = await repo.getFile('src/a b.ts', { ref: 'main' });
    expect(file!.text()).toBe('hello\n');
    expect(file!.etag).toBe('"abc"');
    expect(file!.commit).toBe('c1');
    expect(file!.binary).toBe(false);
    expect(calls[0]!.url.pathname).toBe('/v1/orgs/acme/repos/r/files/src/a%20b.ts');
    expect(calls[0]!.url.searchParams.get('at')).toBe('main');

    const again = await repo.getFile('src/a b.ts', { ifNoneMatch: file!.etag });
    expect(again!.notModified).toBe(true);
    expect(calls[1]!.headers['If-None-Match']).toBe('"abc"');
  });

  it('readFile resolves null for a missing path', async () => {
    const { weft } = client(json(404, { error: 'not in this layout' }));
    expect(await weft.repo('r').readFile('nope')).toBeNull();
  });

  it('maps log entries and the cursor', async () => {
    const { weft, calls } = client(
      json(200, {
        entries: [{ commit: 'c2', tree: 't', parents: ['c1'], author: 'A <a@x> 1 +0000', committer: 'A <a@x> 1 +0000', message: 'm\n', change: 'modified' }],
        next_after: 'c2',
      }),
    );
    const page = await weft.repo('r').listCommits({ path: 'a.txt', limit: 1 });
    expect(page.commits[0]).toMatchObject({ sha: 'c2', parents: ['c1'], change: 'modified' });
    expect(page.nextCursor).toBe('c2');
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ path: 'a.txt', limit: '1' });
  });

  it('asks for a recursive listing with recursive=1', async () => {
    const { weft, calls } = client(json(200, { commit: 'c1', paths: ['a', 'src/'], truncated: false }));
    const files = await weft.repo('r').listFiles({ path: 'src' });
    expect(files.paths).toEqual(['a', 'src/']);
    expect(calls[0]!.url.pathname).toBe('/v1/orgs/acme/repos/r/tree/src');
    expect(calls[0]!.url.searchParams.get('recursive')).toBe('1');
  });

  it('maps a diff', async () => {
    const { weft } = client(json(200, { from: 'a', to: 'b', changes: [{ status: 'added', path: 'x', old_oid: null, new_oid: 'n', old_mode: null, new_mode: '100644' }] }));
    const diff = await weft.repo('r').getDiff({ from: 'a', to: 'b' });
    expect(diff.changes[0]).toEqual({ status: 'added', path: 'x', oldOid: null, newOid: 'n', oldMode: null, newMode: '100644' });
  });

  it('encodes a branch name with a slash as one segment', async () => {
    const { weft, calls } = client(new Response(null, { status: 204 }));
    await weft.repo('r').deleteBranch('feature/x');
    expect(calls[0]!.url.pathname).toBe('/v1/orgs/acme/repos/r/branches/feature%2Fx');
  });
});

describe('getRemoteURL', () => {
  it('mints a short-lived token bound to the repository and embeds it', async () => {
    const { weft, calls } = client(json(201, { id: 'tk', token: 'weft_tk_secret', expires_at: 1 }));
    const url = await weft.repo('session-1', { ...repoInfo(), cloneUrl: 'https://api.weft.sh/acme/session-1.git' }).getRemoteURL({ access: 'read', ttl: 600 });
    expect(url).toBe('https://x:weft_tk_secret@api.weft.sh/acme/session-1.git');
    expect(calls[0]!.url.pathname).toBe('/v1/orgs/acme/tokens');
    expect(calls[0]!.body).toEqual({ scopes: ['repo:read'], repo: 'session-1', label: 'remote:session-1', expires_in_secs: 600 });
  });
});

describe('errors', () => {
  it('reports a network failure as status 0 with the cause', async () => {
    const weft = new Weft({
      token: 't',
      org: 'acme',
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });
    const err = await weft.listRepos().catch((e) => e);
    expect(err).toBeInstanceOf(WeftError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/ECONNREFUSED/);
  });

  it('keeps a non-JSON error body as text', async () => {
    const { weft } = client(new Response('upstream went away', { status: 502 }));
    const err = await weft.listRepos().catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.body).toBe('upstream went away');
  });
});

describe('verifyWebhook', () => {
  const secret = 'whsec';
  const body = JSON.stringify({ event: 'push', repo_id: 'r1', payload: { via: 'api', commit: 'c1', branch: 'main' } });
  const sign = (b: string, s = secret) => 'sha256=' + createHmac('sha256', s).update(b).digest('hex');

  it('accepts a genuine delivery and returns the event', async () => {
    const event = await verifyWebhook({ payload: body, signature: sign(body), secret });
    expect(event).toMatchObject({ event: 'push', repo_id: 'r1' });
  });

  it('accepts the raw bytes as well as a string', async () => {
    expect(await verifyWebhook({ payload: new TextEncoder().encode(body), signature: sign(body), secret })).not.toBeNull();
  });

  it('rejects a tampered body, a wrong secret, a missing or malformed header', async () => {
    expect(await verifyWebhook({ payload: body + ' ', signature: sign(body), secret })).toBeNull();
    expect(await verifyWebhook({ payload: body, signature: sign(body, 'other'), secret })).toBeNull();
    expect(await verifyWebhook({ payload: body, signature: null, secret })).toBeNull();
    expect(await verifyWebhook({ payload: body, signature: 'sha1=abc', secret })).toBeNull();
    expect(await verifyWebhook({ payload: body, signature: sign(body), secret: '' })).toBeNull();
  });
});

function repoInfo() {
  return {
    id: 'r1', org: 'acme', orgId: 'o1', name: 'session-1', description: null, homepage: null,
    kind: 'native' as const, public: false, defaultBranch: 'main', cloneUrl: '', sshCloneUrl: null,
    storedBytes: 0, createdAt: 0, originUrl: null, lastSyncAt: null, lastSyncedCommit: null,
    syncError: null, forkState: null, forkParent: null, forkCount: 0,
  };
}

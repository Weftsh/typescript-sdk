/**
 * The SDK against a real Weft server. The unit tests check what we send;
 * these check that the server agrees, which a mocked fetch cannot.
 *
 *   WEFT_E2E_URL=http://127.0.0.1:8080 WEFT_E2E_TOKEN=weft_… WEFT_E2E_ORG=acme npm run test:e2e
 *
 * Skipped unless all three are set. The token needs org:admin (it mints
 * repo-scoped tokens and creates webhooks). Every repository it makes is
 * deleted at the end.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Weft, WeftConflictError, WeftError, verifyWebhook, type Repo } from '../src/index.js';

const url = process.env.WEFT_E2E_URL;
const token = process.env.WEFT_E2E_TOKEN;
const org = process.env.WEFT_E2E_ORG;
const enabled = Boolean(url && token && org);

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!enabled)('against a live Weft server', () => {
  const weft = new Weft({ token: token!, org: org!, baseUrl: url });
  const made: string[] = [];
  const scratch = mkdtempSync(join(tmpdir(), 'weft-sdk-e2e-'));

  afterAll(async () => {
    if (made.length) await weft.deleteRepos(made);
    rmSync(scratch, { recursive: true, force: true });
  });

  let repo: Repo;
  let first: string;
  let second: string;

  it('creates a repository with a generated name', async () => {
    repo = await weft.createRepo({ description: 'typescript sdk e2e' });
    made.push(repo.name);
    expect(repo.name).toMatch(/^repo-/);
    expect(repo.info?.kind).toBe('native');
    expect(repo.info?.defaultBranch).toBe('main');
    expect(repo.info?.description).toBe('typescript sdk e2e');
    expect(repo.cloneUrl).toContain(`/${org}/${repo.name}.git`);
  });

  it('commits text and binary content with the builder', async () => {
    const result = await repo
      .createCommit({ message: 'first', expectedParent: null, context: { run: 'e2e' }, author: { name: 'SDK', email: 'sdk@weft.test' } })
      .put('README.md', '# hello\n')
      .put('src/app.ts', 'export const x = 1;\n')
      .put('bin/blob', new Uint8Array([0, 1, 2, 255, 0]))
      .send();
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.branch).toBe('main');
    first = result.commit;
  });

  it('refuses a stale expectedParent with the current tip', async () => {
    const second_ = await repo.createCommit({ message: 'second', expectedParent: first }).put('src/app.ts', 'export const x = 2;\n').delete('bin/blob').send();
    second = second_.commit;
    expect(second_.parent).toBe(first);

    const err = await repo.createCommit({ message: 'stale', expectedParent: first }).put('a', 'b').send().catch((e) => e);
    expect(err).toBeInstanceOf(WeftConflictError);
    expect(err.status).toBe(409);
    expect(err.currentTip).toBe(second);
  });

  it('reads files at any revision, with ETag round trips and binary intact', async () => {
    expect(await repo.readFile('src/app.ts')).toBe('export const x = 2;\n');
    expect(await repo.readFile('src/app.ts', { ref: first })).toBe('export const x = 1;\n');
    expect(await repo.readFile('bin/blob')).toBeNull();

    const bin = await repo.getFile('bin/blob', { ref: first });
    expect(Array.from(bin!.bytes)).toEqual([0, 1, 2, 255, 0]);
    expect(bin!.binary).toBe(true);
    expect(bin!.commit).toBe(first);

    const file = await repo.getFile('README.md');
    const again = await repo.getFile('README.md', { ifNoneMatch: file!.etag });
    expect(again!.notModified).toBe(true);
    expect(again!.bytes.length).toBe(0);
  });

  it('lists trees and files', async () => {
    const root = await repo.getTree({ sizes: true });
    expect(root.commit).toBe(second);
    const readme = root.entries.find((e) => e.name === 'README.md');
    expect(readme).toMatchObject({ kind: 'blob', size: 8 });
    expect(root.entries.find((e) => e.name === 'src')).toMatchObject({ kind: 'tree', size: null });

    const withHistory = await repo.getTree({ history: true });
    expect(withHistory.historyTruncated).toBe(false);
    expect(withHistory.entries.find((e) => e.name === 'src')?.lastCommit?.sha).toBe(second);

    const src = await repo.getTree({ path: 'src' });
    expect(src.entries.map((e) => e.name)).toEqual(['app.ts']);

    const all = await repo.listFiles();
    expect(all.paths).toEqual(expect.arrayContaining(['README.md', 'src/', 'src/app.ts']));
    expect(all.truncated).toBe(false);
  });

  it('pages history and filters it by path', async () => {
    const page1 = await repo.listCommits({ limit: 1 });
    expect(page1.commits.map((c) => c.sha)).toEqual([second]);
    expect(page1.nextCursor).toBe(second);
    const page2 = await repo.listCommits({ limit: 1, cursor: page1.nextCursor! });
    expect(page2.commits.map((c) => c.sha)).toEqual([first]);
    expect(page2.commits[0]!.author).toMatch(/^SDK <sdk@weft\.test>/);

    const readme = await repo.listCommits({ path: 'README.md' });
    expect(readme.commits.map((c) => [c.sha, c.change])).toEqual([[first, 'added']]);
  });

  it('diffs two revisions', async () => {
    const diff = await repo.getDiff({ from: first, to: second });
    const byPath = Object.fromEntries(diff.changes.map((c) => [c.path, c.status]));
    expect(byPath).toEqual({ 'bin/blob': 'deleted', 'src/app.ts': 'modified' });
  });

  it('creates, lists and deletes branches and tags, slashes included', async () => {
    expect((await repo.createBranch({ name: 'feature/x', from: first })).oid).toBe(first);
    expect((await repo.createTag({ name: 'v1', target: second })).oid).toBe(second);

    const branches = await repo.listBranches();
    expect(branches.map((b) => [b.name, b.default])).toEqual([['feature/x', false], ['main', true]]);
    expect((await repo.listTags()).map((t) => t.name)).toEqual(['v1']);
    const refs = await repo.listRefs();
    expect(refs.head).toBe('refs/heads/main');
    expect(refs.refs.map((r) => r.name).sort()).toEqual(['refs/heads/feature/x', 'refs/heads/main', 'refs/tags/v1']);

    // Branch and tag names resolve as revisions too, as the README shows.
    expect((await repo.createTag({ name: 'at-main', target: 'main' })).oid).toBe(second);
    expect((await repo.createBranch({ name: 'from-tag', from: 'v1' })).oid).toBe(second);
    expect((await repo.getDiff({ from: 'feature/x', to: 'v1' })).from).toBe(first);

    await repo.deleteBranch('feature/x');
    await repo.deleteBranch('from-tag');
    await repo.deleteTag('v1');
    await repo.deleteTag('at-main');
    expect((await repo.listBranches()).map((b) => b.name)).toEqual(['main']);
  });

  it('undoes with revert and reset, guarded by expectedHead', async () => {
    const reverted = await repo.revert({ expectedHead: second });
    expect(await repo.readFile('src/app.ts')).toBe('export const x = 1;\n');

    const stale = await repo.reset({ to: first, expectedHead: second }).catch((e) => e);
    expect(stale).toBeInstanceOf(WeftConflictError);
    expect(stale.currentTip).toBe(reverted.commit);

    expect((await repo.reset({ to: second, expectedHead: reverted.commit })).oid).toBe(second);
    expect(await repo.readFile('src/app.ts')).toBe('export const x = 2;\n');
  });

  it('updates metadata and finds the repository again', async () => {
    await repo.update({ description: 'renamed', homepage: 'https://example.com' });
    const found = await weft.findOne({ name: repo.name });
    expect(found?.info).toMatchObject({ description: 'renamed', homepage: 'https://example.com' });
    expect(await weft.findOne({ name: 'no-such-repo-anywhere' })).toBeNull();
  });

  it.skipIf(!hasGit())('hands out a working git remote with a repo-scoped credential', async () => {
    const remote = await repo.getRemoteURL({ ttl: 300 });
    expect(remote).toMatch(/^https?:\/\/x:weft_/);
    const dir = join(scratch, 'clone');
    execFileSync('git', ['clone', '--quiet', remote, dir], { stdio: 'pipe' });
    execFileSync('git', ['-C', dir, 'fsck', '--full', '--strict'], { stdio: 'pipe' });
    expect(readFileSync(join(dir, 'src/app.ts'), 'utf8')).toBe('export const x = 2;\n');

    // Push through the same URL, then read the pushed commit back over REST.
    execFileSync('git', ['-C', dir, '-c', 'user.name=Git', '-c', 'user.email=git@weft.test', 'commit', '--quiet', '--allow-empty', '-m', 'from git'], { stdio: 'pipe' });
    execFileSync('git', ['-C', dir, 'push', '--quiet', 'origin', 'main'], { stdio: 'pipe' });
    const tip = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
    expect((await repo.listCommits({ limit: 1 })).commits[0]!.sha).toBe(tip);

    // A read-only URL clones and cannot push.
    const readOnly = await repo.getRemoteURL({ access: 'read', ttl: 300 });
    const ro = join(scratch, 'ro');
    execFileSync('git', ['clone', '--quiet', readOnly, ro], { stdio: 'pipe' });
    execFileSync('git', ['-C', ro, '-c', 'user.name=Git', '-c', 'user.email=git@weft.test', 'commit', '--quiet', '--allow-empty', '-m', 'nope'], { stdio: 'pipe' });
    expect(() => execFileSync('git', ['-C', ro, 'push', '--quiet', 'origin', 'main'], { stdio: 'pipe' })).toThrow();

    // The repo-scoped credential cannot reach another repository.
    const other = await weft.createRepo();
    made.push(other.name);
    const foreign = remote.replace(`/${repo.name}.git`, `/${other.name}.git`);
    expect(() => execFileSync('git', ['ls-remote', foreign], { stdio: 'pipe' })).toThrow();
  });

  it('mints, lists and revokes tokens', async () => {
    const minted = await weft.createToken({ scopes: ['repo:read'], repo: repo.name, label: 'sdk-e2e', ttl: 60 });
    expect(minted.token).toMatch(/^weft_/);
    expect(minted.expiresAt).toBeGreaterThan(Date.now());
    const listed = (await weft.listTokens()).find((t) => t.id === minted.id);
    expect(listed).toMatchObject({ label: 'sdk-e2e', scopes: ['repo:read'], repoId: repo.id });

    const scoped = new Weft({ token: minted.token, org: org!, baseUrl: url });
    expect(await scoped.repo(repo.name).readFile('README.md')).toBe('# hello\n');
    await weft.revokeToken(minted.id);
    const err = await scoped.repo(repo.name).readFile('README.md').catch((e) => e);
    expect(err).toBeInstanceOf(WeftError);
    expect([401, 404]).toContain(err.status);
  });

  it('manages webhook subscriptions', async () => {
    const hook = await repo.createWebhook({ url: 'https://hooks.example.com/weft' });
    expect(hook.secret.length).toBeGreaterThan(10);
    expect((await repo.listWebhooks()).map((h) => h.id)).toContain(hook.id);
    await repo.deleteWebhook(hook.id);
    expect((await repo.listWebhooks()).map((h) => h.id)).not.toContain(hook.id);
  });

  // The server must be able to reach a listener in this process, so only
  // against a server on this machine.
  const loopback = enabled && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url!).hostname);
  it.skipIf(!loopback)('verifies a delivery the server really signed', async () => {
    let received!: (d: { body: string; signature: string | undefined }) => void;
    const delivery = new Promise<{ body: string; signature: string | undefined }>((r) => (received = r));
    const listener = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.end('ok');
        received({ body, signature: req.headers['x-weft-signature-256'] as string | undefined });
      });
    });
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
    try {
      const port = (listener.address() as { port: number }).port;
      const hook = await repo.createWebhook({ url: `http://127.0.0.1:${port}/weft` });
      const made = await repo.createCommit({ message: 'webhook' }).put('hook.txt', 'x').send();
      const d = await delivery;
      const event = await verifyWebhook({ payload: d.body, signature: d.signature, secret: hook.secret });
      expect(event).toMatchObject({ event: 'push', repo_id: repo.id, payload: { via: 'api', commit: made.commit, branch: 'main' } });
      expect(await verifyWebhook({ payload: d.body, signature: d.signature, secret: 'not-the-secret' })).toBeNull();
      await repo.deleteWebhook(hook.id);
    } finally {
      listener.close();
    }
  });

  it('creates and deletes in batches, and lists with a cursor', async () => {
    const names = ['a', 'b', 'c'].map((s) => `sdk-batch-${s}-${Date.now().toString(36)}`);
    const created = await weft.createRepos(names.map((name) => ({ name })));
    expect(created.map((r) => [r.name, r.ok])).toEqual(names.map((n) => [n, true]));
    const dup = await weft.createRepos([{ name: names[0] }]);
    expect(dup[0]).toMatchObject({ ok: false });
    expect(dup[0]!.error).toBeTruthy();

    const seen = new Set<string>();
    for await (const r of weft.iterateRepos({ pageSize: 2 })) seen.add(r.name);
    for (const n of names) expect(seen.has(n)).toBe(true);

    const deleted = await weft.deleteRepos(names);
    expect(deleted.every((r) => r.ok)).toBe(true);
  });

  it('exports a bundle git can clone', async () => {
    let job = await repo.startExport();
    for (let i = 0; i < 100 && job.state !== 'done' && job.state !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = await repo.getExport(job.job);
    }
    expect(job.state).toBe('done');
    const response = await repo.downloadExport(job.job);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 16))).toMatch(/^# v[23] git bundle/);
  });

  it('deletes the repository', async () => {
    const doomed = await weft.createRepo();
    await doomed.delete();
    expect(await weft.findOne({ name: doomed.name })).toBeNull();
  });
});

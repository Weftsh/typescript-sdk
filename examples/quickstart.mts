import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Weft } from '@weftsh/sdk';

const weft = new Weft({
  token: process.env.WEFT_TOKEN!,
  org: process.env.WEFT_ORG!,
  baseUrl: process.env.WEFT_URL, // optional: defaults to https://api.weft.sh
});

// 1. A repository of its own: a real git remote, made in well under a second.
const repo = await weft.createRepo();
console.log('created   ', repo.name);

// 2. A commit, straight over HTTP. No clone, no checkout, no disk.
const { commit } = await repo
  .createCommit({ message: 'first commit' })
  .put('hello.txt', 'hello from the Weft SDK\n')
  .send();
console.log('committed ', commit.slice(0, 7));

// 3. Read it back, at the branch tip or at any commit.
console.log('read back ', JSON.stringify(await repo.readFile('hello.txt')));

// 4. It is still git. This URL carries a credential for this repository
//    only, and it expires in an hour.
const url = await repo.getRemoteURL();
const dir = join(mkdtempSync(join(tmpdir(), 'weft-')), repo.name);
execFileSync('git', ['clone', '--quiet', url, dir]);
console.log('cloned    ', readFileSync(join(dir, 'hello.txt'), 'utf8').trim());

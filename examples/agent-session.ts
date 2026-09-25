/**
 * One repository per agent session: every step is a commit, a bad step is
 * one reset away, and the whole session is a git repository at the end.
 *
 *   WEFT_TOKEN=weft_… WEFT_ORG=acme npx tsx examples/agent-session.ts
 */
import { Weft, WeftConflictError } from '../src/index.js';

const weft = new Weft({
  token: process.env.WEFT_TOKEN!,
  org: process.env.WEFT_ORG ?? 'acme',
  baseUrl: process.env.WEFT_URL,
});

const repo = await weft.createRepo({ description: 'agent session' });
console.log('session repository:', repo.name);

// Step 1: the agent writes a first draft.
const step1 = await repo
  .createCommit({ message: 'step 1: scaffold', expectedParent: null, context: { step: 1 } })
  .put('src/index.ts', 'export function greet() {\n  return "hello";\n}\n')
  .put('README.md', '# greeter\n')
  .send();

// Step 2: the agent goes sideways.
const step2 = await repo
  .createCommit({ message: 'step 2: rewrite everything', expectedParent: step1.commit, context: { step: 2 } })
  .delete('src/index.ts')
  .put('src/index.py', 'print("hello")\n')
  .send();

// Review what step 2 did.
const { changes } = await repo.getDiff({ from: step1.commit, to: step2.commit });
console.log('step 2 changed:', changes.map((c) => `${c.status} ${c.path}`).join(', '));

// Undo it. step 2 stays reachable by SHA for the audit trail.
await repo.reset({ to: step1.commit, expectedHead: step2.commit });
console.log('after undo:', await repo.readFile('src/index.ts'));

// A stale writer is told where the branch really is.
try {
  await repo.createCommit({ message: 'late', expectedParent: step2.commit }).put('x', 'y').send();
} catch (e) {
  if (e instanceof WeftConflictError) console.log('conflict; branch is at', e.currentTip);
  else throw e;
}

// Hand a sandbox a read-only remote for ten minutes.
console.log('git clone', await repo.getRemoteURL({ access: 'read', ttl: 600 }));

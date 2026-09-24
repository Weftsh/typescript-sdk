import type { CommitOperation, CommitOptions, CommitResult, FileContent } from './types.js';

/**
 * Collects file changes and sends them as one commit.
 *
 * ```ts
 * const { commit } = await repo
 *   .createCommit({ message: 'agent step 12' })
 *   .put('src/app.ts', source)
 *   .delete('notes.txt')
 *   .send();
 * ```
 */
export class CommitBuilder {
  private readonly operations: CommitOperation[] = [];

  /** @internal */
  constructor(
    private readonly options: CommitOptions,
    private readonly sender: (options: CommitOptions, operations: CommitOperation[]) => Promise<CommitResult>,
  ) {}

  /** Writes a file, creating it or replacing what is there. Strings are UTF-8; bytes may be anything. */
  put(path: string, content: FileContent): this {
    this.operations.push({ op: 'put', path, content });
    return this;
  }

  /** Removes a file. */
  delete(path: string): this {
    this.operations.push({ op: 'delete', path });
    return this;
  }

  /** How many operations the commit holds so far. */
  get size(): number {
    return this.operations.length;
  }

  /**
   * Makes the commit. Throws a `WeftConflictError` when `expectedParent`
   * no longer matches the branch.
   */
  send(): Promise<CommitResult> {
    return this.sender(this.options, [...this.operations]);
  }
}

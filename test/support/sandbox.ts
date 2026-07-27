/**
 * Scratch directories for tests, created on the same filesystem as the repository.
 *
 * os.tmpdir() is tmpfs on most Linux hosts, and tmpfs never hands a freed directory
 * inode back to the next mkdir. Every lease in this project publishes its directory
 * with mkdir and has to identify it afterwards, so a suite running on tmpfs quietly
 * loses the ability to catch an ownership check that trusts dev/ino — a check that is
 * worthless where the deployment actually keeps its state. Anchoring to this file puts
 * the sandbox on whatever filesystem the checkout lives on, which is that one.
 *
 * Not named *.test.ts, so vitest's include pattern does not collect it as a suite.
 */
import { promises as fs, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '.sandbox');

function sandboxPath(label: string): string {
  return join(ROOT, `${label}-${randomBytes(6).toString('hex')}`);
}

/** A private directory nobody else is using. Pass it to removeSandbox() when done. */
export async function createSandbox(label = 'case'): Promise<string> {
  const path = sandboxPath(label);
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

/** For suites that build their fixtures synchronously. */
export function createSandboxSync(label = 'case'): string {
  const path = sandboxPath(label);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export async function removeSandbox(path: string): Promise<void> {
  await fs.rm(path, { recursive: true, force: true });
}

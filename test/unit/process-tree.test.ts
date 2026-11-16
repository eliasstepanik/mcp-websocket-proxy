/**
 * Unit tests for {@link killProcessTree} (T6, Windows run support).
 *
 * On Windows the helper shells out to `taskkill /T /F`, which cannot be exercised
 * here; what *is* testable on POSIX is the contract the close path relies on:
 * the pid and every process below it are gone when the promise resolves, and a
 * pid that is not there (or not valid) is a silent no-op.
 *
 * The POSIX sweep is proven with a real child + grandchild: `sh -c 'sleep 30 & ...'`
 * leaves `sleep` as a grandchild of the spawned shell, exactly the shape of the
 * `npx.cmd` → `node.exe` tree on Windows.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, waitForFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { killProcessTree } from '../../src/client/process-tree.js';

const workDir = mkdtempSync(join(tmpdir(), 'mcpwp-proctree-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const POSIX = process.platform !== 'win32';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Promise((_, reject) => reject(new Error(`timed out waiting for ${label}`)));
    await sleep(20);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A shell whose only grandchild is `sleep 30`, mirroring the Windows
 * `npx.cmd` (child) → `node.exe` (grandchild) shape.
 *
 * The grandchild writes its own pid to `pidFile`, so the test does not have to
 * parse `ps`/`pgrep` output.
 */
function spawnTree(pidFile: string): { pid: number; exited: Promise<void> } {
  const child = spawn('sh', ['-c', `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`], { stdio: 'ignore' });
  if (child.pid === undefined) throw new Error('could not spawn the test tree');
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  return { pid: child.pid, exited };
}

function readPid(file: string): number {
  const raw = readFileSync(file, 'utf8').trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : NaN;
}

describe.skipIf(!POSIX)('killProcessTree (POSIX sweep)', () => {
  it('kills the pid and its grandchild', async () => {
    const pidFile = join(workDir, 'tree-1.pid');
    const { pid, exited } = spawnTree(pidFile);

    // Wait until the grandchild exists and is alive.
    await waitFor(() => {
      try {
        return isAlive(readPid(pidFile));
      } catch {
        return false;
      }
    }, 'grandchild to start');
    const grandPid = readPid(pidFile);
    expect(isAlive(pid)).toBe(true);
    expect(grandPid).not.toBe(pid);

    await killProcessTree(pid);

    await Promise.race([exited, sleep(5_000)]);
    await waitFor(() => !isAlive(pid), 'child to die');
    await waitFor(() => !isAlive(grandPid), 'grandchild to die');
  });

  it('kills a tree whose root ignores SIGTERM (SIGKILL fallback)', async () => {
    const pidFile = join(workDir, 'tree-2.pid');
    // `trap '' TERM` makes the shell ignore SIGTERM, so only the SIGKILL sweep
    // can take it down; the grandchild is the same `sleep 30` as above.
    const child = spawn('sh', ['-c', `trap '' TERM; sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`], { stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    await waitFor(() => {
      try {
        return isAlive(readPid(pidFile));
      } catch {
        return false;
      }
    }, 'grandchild to start');
    const grandPid = readPid(pidFile);

    await killProcessTree(child.pid as number);

    await Promise.race([exited, sleep(5_000)]);
    expect(isAlive(child.pid as number)).toBe(false);
    await waitFor(() => !isAlive(grandPid), 'grandchild to die');
  });
});

describe('killProcessTree (no-op cases)', () => {
  it('resolves for a pid that is already gone', async () => {
    const child = spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' });
    const pid = child.pid as number;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    // Reaped by Node, so the pid no longer exists.
    expect(isAlive(pid)).toBe(false);
    await expect(killProcessTree(pid)).resolves.toBeUndefined();
  });

  it('resolves without touching anything for invalid pids and for this process', async () => {
    await expect(killProcessTree(0)).resolves.toBeUndefined();
    await expect(killProcessTree(-1)).resolves.toBeUndefined();
    await expect(killProcessTree(Number.NaN)).resolves.toBeUndefined();
    await expect(killProcessTree(1.5)).resolves.toBeUndefined();
    // A self-pid must never be killed: the test process is still here to say so.
    await expect(killProcessTree(process.pid)).resolves.toBeUndefined();
    expect(isAlive(process.pid)).toBe(true);
  });
});

describe('killProcessTree (seam shape)', () => {
  it('is a function that never rejects for a live pid', async () => {
    expect(typeof killProcessTree).toBe('function');
    const probe = spawnSync('sh', ['-c', 'sleep 5'], { stdio: 'ignore' });
    expect(probe.error).toBeUndefined();
    // A live pid: the helper resolves whether or not it owned the process.
    await expect(killProcessTree(process.pid)).resolves.toBeUndefined();
  });
});

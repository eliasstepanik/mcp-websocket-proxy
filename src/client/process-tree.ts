/**
 * Killing a child's whole process tree (T6, Windows run support).
 *
 * On Windows the local servers are usually started through an npm shim: the
 * configured `command` is `npx`, which resolves to `npx.cmd`, which runs
 * `node.exe` as a *grandchild*. Closing the transport only closes the direct
 * child — the shim — and the real MCP server keeps running with its stdin pipe
 * broken, invisible to the agent and to Task Manager's tree. `taskkill /T /F`
 * walks the tree from the pid the transport reports and takes every descendant
 * with it, which is the only reliable way to leave nothing behind.
 *
 * On POSIX the agent's normal shutdown (SIGTERM through the transport, see
 * `local-server.ts`) is already enough, so {@link killProcessTree} is not used
 * there; it still implements a POSIX sweep — descendants first, SIGTERM, then
 * SIGKILL for whatever survived — so the helper behaves the same way on every
 * platform and can be tested on any of them.
 *
 * The helper never rejects: a pid that is already gone, a missing `taskkill` or
 * a missing `pgrep` is a no-op, because it runs on the shutdown path where an
 * error would only hide the real one.
 */

import { spawn } from 'node:child_process';

/** How long a POSIX tree gets to die from SIGTERM before it is SIGKILLed. */
const TERM_GRACE_MS = 250;
/** Guard against a pathological (or cyclic) process tree. */
const MAX_DEPTH = 10;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/** Existence check that never throws. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already exited between the check and the signal */
  }
}

/**
 * Run `command` to completion and resolve with its stdout.
 *
 * Never rejects: a command that cannot be spawned (`ENOENT`) resolves with an
 * empty string, so callers can treat "not installed" as "nothing found".
 */
function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve('');
      return;
    }
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.once('error', () => resolve(''));
    child.once('close', () => resolve(stdout));
  });
}

/** Run `command` for its side effect only. Never rejects. */
function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve();
      return;
    }
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
}

/** Direct children of `pid`, or `[]` when `pgrep` is unavailable or there are none. */
async function directChildren(pid: number): Promise<number[]> {
  const stdout = await runCapture('pgrep', ['-P', String(pid)]);
  return stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value !== pid);
}

/** Every descendant of `pid`, parents before children. */
async function descendants(pid: number, depth = 0): Promise<number[]> {
  if (depth >= MAX_DEPTH) return [];
  const found: number[] = [];
  for (const child of await directChildren(pid)) {
    found.push(child, ...(await descendants(child, depth + 1)));
  }
  return found;
}

/**
 * Kill `pid` and everything below it. Resolves when the sweep is done, whether
 * or not anything was killed.
 *
 * @param pid The pid of a *child* of this process (never this process itself:
 *            a self-pid is ignored rather than killing the agent).
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (pid === process.pid) return;

  if (process.platform === 'win32') {
    // /T walks the tree, /F forces it: an `npx.cmd` shim ignores a polite close
    // and would leave its node grandchild behind.
    await run('taskkill', ['/T', '/F', '/PID', String(pid)]);
    return;
  }

  const tree = await descendants(pid);
  // Deepest first: a parent that dies before its children lets them be reparented
  // to init, where the sweep can no longer reach them.
  const order = tree.slice().reverse();
  for (const descendant of order) signal(descendant, 'SIGTERM');
  signal(pid, 'SIGTERM');

  await delay(TERM_GRACE_MS);

  for (const descendant of order) if (isAlive(descendant)) signal(descendant, 'SIGKILL');
  if (isAlive(pid)) signal(pid, 'SIGKILL');
}

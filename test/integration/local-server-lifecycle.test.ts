/**
 * `LocalMcpServer` lifecycle proof: `stop()` while a `start()` is still in flight must
 * not leak the child process and must not flip the state back to `running`; a request
 * that outlives `requestTimeoutMs` must surface as a *proxy* timeout; and a
 * crash-looping child must actually reach `failed` instead of restarting forever.
 *
 * The silent child is a stdio process that records its pid and then stays silent
 * forever, so the `initialize` handshake is guaranteed to still be pending when
 * `stop()` is called.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { McpError } from '@modelcontextprotocol/sdk/types.js';

import { LocalMcpServer } from '../../src/client/local-server.js';
import { PROXY_ERROR_CODE, PROXY_ERROR_SOURCE } from '../../src/shared/errors.js';

const FIXTURE = new URL('../fixtures/fake-mcp-server.mjs', import.meta.url).pathname;

/** `process.env` narrowed to `Record<string, string>`, as `LocalServerOptions.env` requires. */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    ...extra,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const workDir = mkdtempSync(join(tmpdir(), 'mcpwp-lifecycle-'));

/** A stdio process that starts, records its pid, then never speaks. */
const SILENT_CHILD = 'const fs = require("node:fs");\nfs.writeFileSync(process.env.PID_FILE, String(process.pid));\nsetTimeout(() => {}, 60000);\n';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('LocalMcpServer lifecycle', () => {
  it('stop() during starting leaves no orphan child and keeps the state stopped', async () => {
    const pidFile = join(workDir, 'silent-child.pid');
    const stateChanges: string[] = [];
    const server = new LocalMcpServer({
      name: 'silent',
      command: process.execPath,
      args: ['-e', SILENT_CHILD],
      env: { ...process.env, PID_FILE: pidFile },
      restartDelays: [50],
      requestTimeoutMs: 20_000,
      onStderrLine: () => undefined,
      onStateChange: (state) => stateChanges.push(state),
    });

    // Not awaited: the handshake never completes on its own.
    const starting = server.start();
    await waitFor(() => existsSync(pidFile), 10_000, 'child to spawn');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(server.currentState).toBe('starting');

    await server.stop();

    // No orphan: stop() closed the in-flight child.
    await waitFor(() => !isAlive(pid), 15_000, 'in-flight child to exit');

    // The state stays `stopped`: the handshake that finishes late must not adopt the child.
    expect(server.currentState).toBe('stopped');
    expect(server.available).toBe(false);
    expect(server.pid).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(server.currentState).toBe('stopped');
    expect(stateChanges).not.toContain('running');
    expect(stateChanges).not.toContain('backoff');
    expect(stateChanges).not.toContain('failed');

    // The abandoned start() settles instead of leaving an unhandled rejection.
    await expect(starting).resolves.toBeUndefined();
  });

  it('start() is a no-op while the server is already running', async () => {
    const stateChanges: string[] = [];
    const server = new LocalMcpServer({
      name: 'fake',
      command: process.execPath,
      args: [FIXTURE],
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      requestTimeoutMs: 20_000,
      onStderrLine: () => undefined,
      onStateChange: (state) => stateChanges.push(state),
    });

    try {
      await server.start();
      expect(server.currentState).toBe('running');
      const pid = server.pid;
      expect(pid).not.toBeNull();

      await server.start();
      expect(server.currentState).toBe('running');
      expect(server.pid).toBe(pid);
      expect(stateChanges.filter((s) => s === 'starting')).toHaveLength(1);
    } finally {
      await server.stop();
    }
    expect(server.currentState).toBe('stopped');
  });

  it('reports a request that exceeds requestTimeoutMs as a proxy timeout', async () => {
    // The SDK surfaces its own deadline as an *upstream* `RequestTimeout` (-32001);
    // the proxy must rewrite it into its own -32050 / reason `timeout`.
    const server = new LocalMcpServer({
      name: 'fake',
      command: process.execPath,
      args: [FIXTURE],
      env: childEnv(),
      requestTimeoutMs: 300,
      onStderrLine: () => undefined,
    });

    try {
      await server.start();
      const error = await server
        .request('tools/call', { name: 'slow', arguments: { ms: 5_000 } })
        .then(() => undefined)
        .catch((e: unknown) => e as McpError);
      expect(error).toBeInstanceOf(McpError);
      expect(error!.code).toBe(PROXY_ERROR_CODE);
      expect((error!.data as { source?: string; reason?: string }).source).toBe(PROXY_ERROR_SOURCE);
      expect((error!.data as { reason?: string }).reason).toBe('timeout');
    } finally {
      await server.stop();
    }
  });

  it('gives up on a crash-looping child instead of restarting at the minimum delay forever', async () => {
    // A child that completes `initialize` and then dies ~50ms later: a successful
    // handshake must not reset the attempt counter, otherwise `maxRestarts` is never
    // reached and the child restarts at the minimum backoff delay forever.
    const stateChanges: string[] = [];
    const server = new LocalMcpServer({
      name: 'fake',
      command: process.execPath,
      args: [FIXTURE],
      env: childEnv({ FIXTURE_CRASH_MS: '50' }),
      restartDelays: [20],
      maxRestarts: 2,
      // Long enough that the ~50ms uptimes never count as stable.
      stableUptimeMs: 5_000,
      requestTimeoutMs: 20_000,
      onStderrLine: () => undefined,
      onStateChange: (state) => stateChanges.push(state),
    });

    try {
      await server.start();
      await waitFor(() => server.currentState === 'failed', 15_000, 'failed state after maxRestarts');
      // Exactly `maxRestarts` restarts were granted, then the server gave up.
      expect(stateChanges.filter((s) => s === 'backoff')).toHaveLength(2);
      expect(server.available).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it('restarts from the minimum delay after a child that stayed up long enough', async () => {
    // The other half of the rule: a child that stayed up past `stableUptimeMs` resets
    // the attempt counter, so a later crash does not inherit the earlier failure's
    // attempt count and hit `maxRestarts` immediately.
    //
    // Spawn 1 exits before the handshake (attempt climbs to `maxRestarts`), spawn 2
    // runs the fixture and stays up; killing it must still be restarted (spawn 3)
    // instead of going `failed`.
    const countFile = join(workDir, `reset-count-${Date.now()}`);
    const CHILD =
      'const fs = require("node:fs");\n' +
      'const n = fs.existsSync(process.env.COUNT_FILE) ? Number(fs.readFileSync(process.env.COUNT_FILE, "utf8")) : 0;\n' +
      'fs.writeFileSync(process.env.COUNT_FILE, String(n + 1));\n' +
      'if (n === 0) process.exit(1);\n' +
      'import(process.env.FIXTURE);\n';
    const stateChanges: string[] = [];
    const server = new LocalMcpServer({
      name: 'fake',
      command: process.execPath,
      args: ['-e', CHILD],
      env: childEnv({ COUNT_FILE: countFile, FIXTURE }),
      // The second delay is huge: only a reset counter can restart quickly.
      restartDelays: [20, 60_000],
      maxRestarts: 1,
      stableUptimeMs: 100,
      requestTimeoutMs: 20_000,
      onStderrLine: () => undefined,
      onStateChange: (state) => stateChanges.push(state),
    });

    try {
      // Spawn 1 dies before `initialize`, so the first `start()` rejects.
      await server.start().catch(() => undefined);
      await waitFor(() => server.currentState === 'running', 15_000, 'second child running');

      // Stay up clearly past `stableUptimeMs`, so this child counts as healthy.
      await sleep(400);
      process.kill(server.pid!, 'SIGKILL');

      await waitFor(
        () => stateChanges.filter((s) => s === 'running').length >= 2 || stateChanges.includes('failed'),
        15_000,
        'restart after a stable child died',
      );
      expect(stateChanges).not.toContain('failed');
      expect(stateChanges.filter((s) => s === 'running')).toHaveLength(2);
    } finally {
      await server.stop();
    }
  });

  it('passes the default environment through to the child alongside the configured env', async () => {
    // A configured `env` must be merged onto the SDK's default environment, not
    // replace it: on Windows PATH/SYSTEMROOT would otherwise vanish.
    const envFile = join(workDir, 'child-env.json');
    const server = new LocalMcpServer({
      name: 'fake',
      command: process.execPath,
      args: [FIXTURE],
      // Only configured vars here: the defaults (PATH, HOME / SYSTEMROOT) come from the SDK.
      env: { PROXY_TEST_ONLY: 'yes', FIXTURE_ENV_FILE: envFile },
      requestTimeoutMs: 20_000,
      onStderrLine: () => undefined,
    });

    try {
      await server.start();
      await waitFor(() => existsSync(envFile), 10_000, 'child env dump');
      const seen = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string | undefined>;
      expect(seen.PROXY_TEST_ONLY).toBe('yes');
      expect(seen.PATH).toBe(process.env.PATH);
      expect(seen.HOME ?? seen.SYSTEMROOT).toBeTruthy();
    } finally {
      await server.stop();
    }
  });

  it('prefixes stderr with the pid of the spawn that produced the line', async () => {
    // A line written before the fixture even loads must still carry *this* child's pid:
    // reading `this.transport` would print `?` during startup (or a newer child's pid).
    const stateChanges: string[] = [];
    const EARLY = 'process.stderr.write("early line\\n");\nimport(process.env.FIXTURE);\n';
    const lines: string[] = [];
    const server = new LocalMcpServer({
      name: 'fake',
      command: process.execPath,
      args: ['-e', EARLY],
      env: childEnv({ FIXTURE }),
      requestTimeoutMs: 20_000,
      onStderrLine: (line) => lines.push(line),
      onStateChange: (state) => stateChanges.push(state),
    });

    try {
      await server.start();
      await waitFor(() => lines.some((line) => line.includes('early line')), 10_000, 'early stderr line');
      const early = lines.find((line) => line.includes('early line'))!;
      expect(early).toBe(`[fake:pid=${server.pid}] early line`);
    } finally {
      await server.stop();
    }
  });

  it('prefixes a line that already looks prefixed, so a child cannot spoof another server', async () => {
    const SPOOF = 'process.stderr.write("[other:pid=999] spoofed\\n");\nimport(process.env.FIXTURE);\n';
    const lines: string[] = [];
    const server = new LocalMcpServer({
      name: 'fake',
      command: process.execPath,
      args: ['-e', SPOOF],
      env: childEnv({ FIXTURE }),
      requestTimeoutMs: 20_000,
      onStderrLine: (line) => lines.push(line),
    });

    try {
      await server.start();
      await waitFor(() => lines.some((line) => line.includes('spoofed')), 10_000, 'spoofed stderr line');
      // Our prefix always wins; the child's own header stays plain text.
      expect(lines.find((line) => line.includes('spoofed'))).toBe(`[fake:pid=${server.pid}] [other:pid=999] spoofed`);
    } finally {
      await server.stop();
    }
  });

  it('flushes a dead child partial line under its own pid instead of gluing it to the next child', async () => {
    // First spawn writes a line without a newline and exits; the second spawn writes a
    // complete line. The dangling partial must be flushed under the *first* pid and the
    // second child's line must start clean.
    const countFile = join(workDir, `partial-count-${Date.now()}`);
    const PARTIAL_CHILD =
      'const fs = require("node:fs");\n' +
      'const n = fs.existsSync(process.env.COUNT_FILE) ? Number(fs.readFileSync(process.env.COUNT_FILE, "utf8")) : 0;\n' +
      'fs.writeFileSync(process.env.COUNT_FILE, String(n + 1));\n' +
      'if (n === 0) { process.stderr.write("partial-from-first-child"); setTimeout(() => process.exit(1), 50); }\n' +
      'else { process.stderr.write("second-child-line\\n"); setTimeout(() => {}, 60000); }\n';
    const lines: string[] = [];
    const server = new LocalMcpServer({
      name: 'fake',
      command: process.execPath,
      args: ['-e', PARTIAL_CHILD],
      env: childEnv({ COUNT_FILE: countFile }),
      restartDelays: [20],
      requestTimeoutMs: 20_000,
      onStderrLine: (line) => lines.push(line),
    });

    try {
      // Never resolves: the first child dies before the handshake, so `start()` rejects
      // with `server_down` while the supervisor restarts it in the background.
      void server.start().catch(() => undefined);
      await waitFor(() => lines.some((line) => line.includes('second-child-line')), 15_000, "second child's line");

      const partial = lines.find((line) => line.includes('partial-from-first-child'));
      const second = lines.find((line) => line.includes('second-child-line'));
      expect(partial).toBeDefined();
      expect(second).toBeDefined();
      // No glueing: each line carries exactly one payload and its own pid prefix.
      expect(partial).toMatch(/^\[fake:pid=\d+] partial-from-first-child$/);
      expect(second).toMatch(/^\[fake:pid=\d+] second-child-line$/);
      const pidOf = (line: string): string => line.slice('[fake:pid='.length, line.indexOf(']'));
      expect(pidOf(partial!)).not.toBe(pidOf(second!));
    } finally {
      await server.stop();
    }
  });

  it('force-flushes a newline-less stderr line past the 64 KiB cap', async () => {
    const CAP = 64 * 1024;
    const BIG_CHILD = `process.stderr.write("x".repeat(${CAP + 4096}));\nsetTimeout(() => {}, 60000);\n`;
    const lines: string[] = [];
    const server = new LocalMcpServer({
      name: 'fake',
      command: process.execPath,
      args: ['-e', BIG_CHILD],
      env: childEnv(),
      requestTimeoutMs: 20_000,
      onStderrLine: (line) => lines.push(line),
    });

    try {
      // Never resolves: the child stays silent on stdout, so the handshake stays pending.
      void server.start();
      await waitFor(() => lines.length > 0, 15_000, 'a big stderr chunk');
      const payloads = lines.map((line) => line.replace(/^\[fake:pid=[^\]]*\] /, ''));
      // Exactly one cap-sized line was force-flushed; the remainder stays buffered.
      expect(payloads).toEqual(['x'.repeat(CAP)]);
    } finally {
      await server.stop();
    }
  });

  it('keeps the cached initialize info when a respawn fails', async () => {
    // A wrapper around the fixture that refuses to start once the marker file exists,
    // so the *first* handshake succeeds and the automatic respawn fails.
    const failFile = join(workDir, 'make-respawn-fail');
    const WRAPPER = 'if (require("node:fs").existsSync(process.env.FAIL_FILE)) process.exit(1);\nimport(process.env.FIXTURE);\n';
    const stateChanges: string[] = [];
    const server = new LocalMcpServer({
      name: 'fake',
      command: process.execPath,
      args: ['-e', WRAPPER],
      env: { ...process.env, FAIL_FILE: failFile, FIXTURE },
      restartDelays: [50],
      maxRestarts: 1,
      requestTimeoutMs: 20_000,
      onStderrLine: () => undefined,
      onStateChange: (state) => stateChanges.push(state),
    });

    try {
      await server.start();
      expect(server.currentState).toBe('running');
      const goodInfo = server.info;
      expect(goodInfo.serverInfo.name).toBe('fake-mcp-server');

      // Kill the child with the respawn already doomed: the restart attempt fails.
      writeFileSync(failFile, '');
      process.kill(server.pid!, 'SIGKILL');
      await waitFor(() => server.currentState === 'failed', 15_000, 'failed state after a bad respawn');
      expect(stateChanges).toContain('backoff');

      // A restart hiccup must not turn new `initialize` requests into 503s: the last
      // good info survives, while availability is gated separately by the state.
      expect(server.info).toEqual(goodInfo);
      expect(server.available).toBe(false);
    } finally {
      await server.stop();
    }
  });
});

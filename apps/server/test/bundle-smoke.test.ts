// The CI gate from ARCHITECTURE §10.1: the bundled dist/main.js (not tsx) boots against Postgres,
// migrates, serves /health, completes one socket round trip, and drains on SIGTERM.
// Run `pnpm --filter @gp/server build` first; skipped when dist/ is missing.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { startTestDb, type TestDb } from '@gp/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, connect, freePort, hello, rawEnv } from './helpers';

const MAIN = path.resolve(import.meta.dirname, '../dist/main.js');

describe.skipIf(!existsSync(MAIN))('bundled dist/main.js', () => {
  let testDb: TestDb;
  let child: ChildProcess | null = null;
  let output = '';

  beforeAll(async () => {
    testDb = await startTestDb();
  });

  afterAll(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await testDb?.stop();
  });

  async function waitForHealth(port: number): Promise<Response> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child?.exitCode !== null) throw new Error(`server exited early:\n${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) return response;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`no /health within 30 s:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('boots, migrates, serves /health and a socket, and drains on SIGTERM', async () => {
    const port = await freePort();
    const env = rawEnv({
      DATABASE_URL: testDb.url,
      DATABASE_URL_DIRECT: testDb.url,
      PORT: String(port),
      LOG_LEVEL: 'info',
      BUILD_SHA: 'smoke-sha',
    });
    const proc = spawn(process.execPath, ['--max-old-space-size=384', MAIN], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    proc.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    proc.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<number | null>((resolve) =>
      proc.once('exit', (code) => resolve(code)),
    );

    const health = await waitForHealth(port);
    expect(health.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await health.json()).toMatchObject({ ok: true, buildSha: 'smoke-sha', epoch: 1 });

    // The lazily loaded planck chunk resolves from the bundle.
    const bench = await fetch(`http://127.0.0.1:${port}/ops/bench/carrom?shots=2`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(bench.status).toBe(200);
    expect(await bench.json()).toMatchObject({ shots: 2 });

    const socket = await connect(port);
    expect(await socket.emitWithAck('hello', hello())).toMatchObject({ ok: true, epoch: 1 });
    const moving = new Promise((resolve) => socket.once('server:moving', resolve));

    const signalled = Date.now();
    proc.kill('SIGTERM');
    expect(await moving).toEqual({ reason: 'DEPLOY' });
    expect(await exited).toBe(0);
    expect(Date.now() - signalled).toBeLessThan(10_000);
    socket.close();

    expect(output).toContain('server booted');
    expect(output).toContain('shutdown complete');
    for (const key of ['JWT_SECRET', 'REFRESH_SECRET', 'K_ROTATE', 'ADMIN_TOKEN'] as const) {
      expect(output).not.toContain(env[key]);
    }
  });
});

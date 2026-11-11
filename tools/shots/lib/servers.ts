import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { DESKTOP_DIR, EDITOR_DIR } from './paths.ts';

export interface ServerSpec {
  name: string;
  url: string;
  /** Working directory the dev server is started from. */
  cwd: string;
  /** Arguments after the vite binary. */
  args: string[];
  /** A string the served index page must contain, so another app on the same port is not mistaken for ours. */
  marker: string;
}

export const DESKTOP_URL = process.env.SHOTS_DESKTOP_URL ?? 'http://127.0.0.1:3200';
export const PLAYGROUND_URL = process.env.SHOTS_PLAYGROUND_URL ?? 'http://127.0.0.1:5199';

const portOf = (url: string) => new URL(url).port;

export const DESKTOP_SERVER: ServerSpec = {
  name: 'desktop UI (mock mode)',
  url: DESKTOP_URL,
  cwd: DESKTOP_DIR,
  args: ['--port', portOf(DESKTOP_URL), '--host', '127.0.0.1', '--strictPort'],
  marker: '/src/preview/main.tsx',
};

export const PLAYGROUND_SERVER: ServerSpec = {
  name: 'editor playground',
  url: PLAYGROUND_URL,
  cwd: EDITOR_DIR,
  args: ['playground', '--port', portOf(PLAYGROUND_URL), '--host', '127.0.0.1', '--strictPort'],
  marker: './main.tsx',
};

async function serves(spec: ServerSpec): Promise<boolean> {
  try {
    const res = await fetch(spec.url, { signal: AbortSignal.timeout(2500) });
    return res.ok && (await res.text()).includes(spec.marker);
  } catch {
    return false;
  }
}

/** Resolves the vite entry script from the workspace's own node_modules, so no shell or PATH lookup is needed. */
function viteBin(cwd: string): string {
  const pkgPath = createRequire(join(cwd, 'package.json')).resolve('vite/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.vite;
  if (!bin) throw new Error('vite has no bin entry');
  return join(dirname(pkgPath), bin);
}

function kill(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

export class Servers {
  private readonly started: ChildProcess[] = [];

  /** Starts the dev server unless something that looks like it is already answering on the port. */
  async ensure(spec: ServerSpec): Promise<void> {
    if (await serves(spec)) {
      console.log(`  ${spec.name}: using the server already running at ${spec.url}`);
      return;
    }
    console.log(`  ${spec.name}: starting vite on ${spec.url} ...`);
    const child = spawn(process.execPath, [viteBin(spec.cwd), ...spec.args], {
      cwd: spec.cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    this.started.push(child);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`${spec.name} exited with code ${child.exitCode}\n${stderr}`);
      if (await serves(spec)) return;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`${spec.name} did not come up at ${spec.url} within 120 s\n${stderr}`);
  }

  stop(): void {
    for (const child of this.started) kill(child);
    this.started.length = 0;
  }
}

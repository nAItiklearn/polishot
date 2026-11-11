#!/usr/bin/env node
// Guards two conventions in .github/workflows/*.yml, so edits by people, agents or Dependabot cannot
// quietly break them:
//
//   1. Every third-party `uses:` is pinned to a full 40-character commit SHA and carries a version
//      comment (`# v1.2.3`) that Dependabot keeps in sync.
//   2. Every `pnpm` command in a `run:` step names a script that exists: `pnpm --filter <name> <script>`
//      must be in that package's "scripts", `pnpm -r ... run <script>` in at least one package, and a bare
//      `pnpm <script>` in the root package.json.
//
//   node scripts/ci/check-workflows.mjs [workflow-dir]
//
// No dependencies. Prints one `file:line: message` per problem and exits 1 if there are any.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowDir = process.argv[2] ? resolve(process.argv[2]) : join(root, '.github', 'workflows');
const problems = [];
const report = (file, line, message) => problems.push(`${file}:${line}: ${message}`);

/* ------------------------------------------------------------------------------------------------ */
/* Workspace packages                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function workspacePatterns() {
  const text = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').replace(/\r\n/g, '\n');
  const patterns = [];
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^packages:\s*$/.test(line)) inPackages = true;
    else if (/^\S/.test(line)) inPackages = false;
    else if (inPackages) {
      const m = /^\s*-\s*["']?([^"']+?)["']?\s*$/.exec(line);
      if (m) patterns.push(m[1]);
    }
  }
  return patterns;
}

function expand(pattern) {
  if (!pattern.endsWith('/*')) return [pattern];
  const base = join(root, pattern.slice(0, -2));
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((name) => `${pattern.slice(0, -2)}/${name}`)
    .filter((dir) => statSync(join(root, dir)).isDirectory());
}

const rootPackage = readJson(join(root, 'package.json'));
const packages = new Map(); // name -> scripts
for (const dir of workspacePatterns().flatMap(expand)) {
  const file = join(root, dir, 'package.json');
  if (!existsSync(file)) continue;
  const pkg = readJson(file);
  if (pkg.name) packages.set(pkg.name, pkg.scripts ?? {});
}
const rootScripts = rootPackage.scripts ?? {};

/* ------------------------------------------------------------------------------------------------ */
/* pnpm command checks                                                                                */
/* ------------------------------------------------------------------------------------------------ */

// pnpm sub-commands that are not scripts. `pnpm <anything else>` runs a script.
const PNPM_BUILTINS = new Set([
  'approve-builds',
  'audit',
  'fetch',
  'licenses',
  'patch',
  'patch-commit',
  'peers',
  'prune',
  'add',
  'config',
  'dlx',
  'dedupe',
  'exec',
  'i',
  'install',
  'ls',
  'list',
  'outdated',
  'pack',
  'publish',
  'rebuild',
  'remove',
  'rm',
  'store',
  'up',
  'update',
  'why',
  'setup',
  'self-update',
]);
// Options that take a value in the next token.
const VALUE_OPTIONS = new Set(['--filter', '-F', '--dir', '-C', '--workspace-concurrency']);

function checkPnpm(file, line, command) {
  const tokens = command.split(/\s+/).filter(Boolean);
  let filter = null;
  let recursive = false;
  let i = 0;
  for (; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!t.startsWith('-')) break;
    if (t === '-r' || t === '--recursive') recursive = true;
    else if (t.startsWith('--filter=')) filter = t.slice('--filter='.length);
    else if (VALUE_OPTIONS.has(t)) {
      if (t === '--filter' || t === '-F') filter = tokens[i + 1] ?? null;
      i += 1;
    }
  }
  let word = tokens[i];
  if (!word || PNPM_BUILTINS.has(word)) return;
  if (word === 'run' || word === 'run-script') word = tokens[i + 1];
  if (!word || word.startsWith('-')) return;

  if (filter) {
    const name = filter.replace(/^\.\.\./, '').replace(/\.\.\.$/, '');
    const scripts = packages.get(name);
    if (!scripts)
      report(file, line, `pnpm --filter ${filter}: no workspace package with that name`);
    else if (!(word in scripts)) report(file, line, `${name} has no "${word}" script`);
  } else if (recursive) {
    if (![...packages.values()].some((scripts) => word in scripts)) {
      report(file, line, `pnpm -r ${word}: no workspace package defines a "${word}" script`);
    }
  } else if (!(word in rootScripts)) {
    report(file, line, `the root package.json has no "${word}" script`);
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Workflow scan                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

const indentOf = (line) => line.length - line.trimStart().length;

function scan(name) {
  const lines = readFileSync(join(workflowDir, name), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const file = `.github/workflows/${name}`;
  let runIndent = -1; // indentation of the `run:` key while inside its block scalar, else -1

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const trimmed = raw.trim();

    // Third-party actions.
    const uses = /^-?\s*uses:\s*(\S+)\s*(?:#\s*(.*))?$/.exec(trimmed);
    if (uses) {
      const [, ref, comment] = uses;
      if (!ref.startsWith('./') && !ref.startsWith('docker://')) {
        if (!/@[0-9a-f]{40}$/.test(ref))
          report(file, lineNo, `${ref} is not pinned to a full commit SHA`);
        else if (!comment || !comment.trim())
          report(file, lineNo, `${ref} needs a "# vX.Y.Z" version comment`);
      }
      return;
    }

    // run: steps.
    if (runIndent >= 0) {
      if (trimmed === '' || indentOf(raw) > runIndent) {
        if (!trimmed.startsWith('#')) scanCommand(file, lineNo, trimmed);
        return;
      }
      runIndent = -1;
    }
    const run = /^(-\s+)?run:\s*(.*)$/.exec(trimmed);
    if (run) {
      const value = run[2].trim();
      if (/^[|>][+-]?$/.test(value)) {
        runIndent = indentOf(raw) + (run[1] ? run[1].length : 0);
      } else if (value) {
        scanCommand(file, lineNo, value.replace(/^["']|["']$/g, ''));
      }
    }
  });
}

function scanCommand(file, lineNo, text) {
  // A line may chain several commands; check each `pnpm ...` segment on its own.
  for (const segment of text.split(/&&|\|\||;|\|/)) {
    const m = /^pnpm\s+(.+)$/.exec(segment.trim().replace(/\s+#.*$/, ''));
    if (m) checkPnpm(file, lineNo, m[1]);
  }
}

const workflows = readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f));
if (workflows.length === 0) problems.push('.github/workflows: no workflow files found');
for (const name of workflows) scan(name);

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s) in ${workflows.length} workflow file(s).`);
  process.exit(1);
}
console.log(`OK: ${workflows.length} workflow files, actions pinned, pnpm scripts exist.`);

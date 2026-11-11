#!/usr/bin/env node
// Prints the CHANGELOG.md section for one version, for the GitHub Release notes.
//
//   node scripts/ci/changelog-section.mjs <version|vTag> [path/to/CHANGELOG.md]
//
// A section starts at a level-2 heading whose first word is the version (optionally `v`-prefixed
// or in brackets), e.g. `## 0.1.0 — Unreleased` or `## [0.1.0] - 2026-11-20`, and ends at the next
// level-2 heading. The heading itself is not printed. Exits 1 when the section is missing or empty,
// so a release cannot go out without notes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [, , rawVersion, file = 'CHANGELOG.md'] = process.argv;
if (!rawVersion) {
  console.error('usage: changelog-section.mjs <version> [CHANGELOG.md]');
  process.exit(2);
}

const version = rawVersion.replace(/^refs\/tags\//, '').replace(/^v/, '');
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(?=\\s|$)`);

const lines = readFileSync(resolve(file), 'utf8').replace(/\r\n/g, '\n').split('\n');
const start = lines.findIndex((line) => heading.test(line));
if (start === -1) {
  console.error(`No "## ${version}" section in ${file}.`);
  process.exit(1);
}

let end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
if (end === -1) end = lines.length;

const body = lines
  .slice(start + 1, end)
  .join('\n')
  .trim();
if (!body) {
  console.error(`The "## ${version}" section in ${file} is empty.`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);

import fs from 'node:fs';
import path from 'node:path';
import { inlineText, parseMarkdown, type Block } from './markdown';

export interface Release {
  /** Heading text before the dash, for example "0.1.0". */
  version: string;
  /** Text after the dash, for example "Unreleased" or a date. Empty when absent. */
  label: string;
  unreleased: boolean;
  blocks: Block[];
}

/** Splits a changelog into releases. Everything before the first "## " heading is ignored. */
export function parseChangelog(source: string): Release[] {
  const blocks = parseMarkdown(source);
  const releases: Release[] = [];
  let current: Release | null = null;

  for (const block of blocks) {
    if (block.type === 'heading' && block.level === 2) {
      const title = inlineText(block.children);
      const match = /^(.*?)\s+[—–-]\s+(.*)$/.exec(title);
      const version = (match ? match[1] : title)?.trim() ?? title;
      const label = match ? (match[2]?.trim() ?? '') : '';
      current = { version, label, unreleased: /unreleased/i.test(label), blocks: [] };
      releases.push(current);
    } else if (current) {
      current.blocks.push(block);
    }
  }
  return releases;
}

const CANDIDATES = ['../../CHANGELOG.md', './CHANGELOG.md'];

/** Reads the repository CHANGELOG.md at build time. The site is statically rendered, so this runs once per build. */
export function loadChangelog(): Release[] {
  for (const candidate of CANDIDATES) {
    const file = path.resolve(process.cwd(), candidate);
    if (fs.existsSync(file)) return parseChangelog(fs.readFileSync(file, 'utf8'));
  }
  return [];
}

export function latestRelease(): Release | null {
  return loadChangelog()[0] ?? null;
}

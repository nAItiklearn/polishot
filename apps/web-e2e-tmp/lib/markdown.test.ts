import { describe, expect, it } from 'vitest';
import { parseChangelog } from './changelog';
import { isSafeHref, parseInline, parseMarkdown } from './markdown';

describe('parseMarkdown', () => {
  it('reads headings, paragraphs and lists', () => {
    const blocks = parseMarkdown(
      ['# Title', '', 'One line', 'continues here.', '', '- first', '- second', '', '### Fixed'].join(
        '\n',
      ),
    );
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'heading']);
    expect(blocks[1]).toEqual({
      type: 'paragraph',
      children: [{ type: 'text', value: 'One line continues here.' }],
    });
    const list = blocks[2];
    expect(list?.type === 'list' && list.items).toHaveLength(2);
  });

  it('handles Windows line endings', () => {
    const blocks = parseMarkdown('## A\r\n\r\n- x\r\n- y\r\n');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'list']);
  });

  it('joins indented continuation lines to the bullet above', () => {
    const blocks = parseMarkdown('- long item\n  that wraps');
    const list = blocks[0];
    expect(list?.type === 'list' && list.items[0]).toEqual([
      { type: 'text', value: 'long item' },
      { type: 'text', value: ' that wraps' },
    ]);
  });

  it('keeps HTML as literal text instead of interpreting it', () => {
    const [block] = parseMarkdown('<script>alert(1)</script> and <img src=x onerror=alert(1)>');
    expect(block).toEqual({
      type: 'paragraph',
      children: [
        { type: 'text', value: '<script>alert(1)</script> and <img src=x onerror=alert(1)>' },
      ],
    });
  });
});

describe('parseInline', () => {
  it('reads code, bold and links', () => {
    expect(parseInline('Press `Space` for **window** mode, see [docs](https://example.com/a).')).toEqual([
      { type: 'text', value: 'Press ' },
      { type: 'code', value: 'Space' },
      { type: 'text', value: ' for ' },
      { type: 'strong', children: [{ type: 'text', value: 'window' }] },
      { type: 'text', value: ' mode, see ' },
      { type: 'link', href: 'https://example.com/a', children: [{ type: 'text', value: 'docs' }] },
      { type: 'text', value: '.' },
    ]);
  });

  it('drops unsafe link targets but keeps the label', () => {
    expect(parseInline('[click](javascript:alert(1))')).toEqual([{ type: 'text', value: 'click' }]);
    expect(parseInline('[x](data:text/html;base64,AAAA)')).toEqual([{ type: 'text', value: 'x' }]);
  });
});

describe('isSafeHref', () => {
  it('allows web, mail, anchor and site-relative targets', () => {
    for (const ok of ['https://a.test', 'http://a.test', 'mailto:a@b.test', '#top', '/pricing']) {
      expect(isSafeHref(ok)).toBe(true);
    }
  });

  it('rejects scripts, data URLs and protocol-relative links', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.test', 'vbscript:x', 'file:///c:/']) {
      expect(isSafeHref(bad)).toBe(false);
    }
  });
});

describe('parseChangelog', () => {
  const source = [
    '# Changelog',
    '',
    'Intro that is ignored.',
    '',
    '## 0.2.0 — 2027-01-05',
    '',
    '### Added',
    '- Batch export',
    '',
    '## 0.1.0 — Unreleased',
    '',
    '- First cut',
    '',
  ].join('\n');

  it('splits releases and reads version and label', () => {
    const releases = parseChangelog(source);
    expect(releases.map((r) => [r.version, r.label, r.unreleased])).toEqual([
      ['0.2.0', '2027-01-05', false],
      ['0.1.0', 'Unreleased', true],
    ]);
    expect(releases[0]?.blocks.map((b) => b.type)).toEqual(['heading', 'list']);
  });

  it('accepts a plain hyphen and a heading without a label', () => {
    const releases = parseChangelog('## 1.0.0 - Unreleased\n\n- x\n\n## 0.9.0\n\n- y');
    expect(releases.map((r) => [r.version, r.label])).toEqual([
      ['1.0.0', 'Unreleased'],
      ['0.9.0', ''],
    ]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseChangelog('')).toEqual([]);
  });
});

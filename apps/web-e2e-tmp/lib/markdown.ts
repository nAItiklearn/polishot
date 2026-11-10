/**
 * A deliberately small markdown reader for CHANGELOG.md: headings, paragraphs, bullet lists and a
 * few inline marks (code, bold, links). It produces plain data, never HTML. The renderer turns that
 * data into React elements, so every piece of text is escaped by React and nothing is injected raw.
 */

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] };

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'list'; items: Inline[][] };

// Link targets may contain one level of balanced parentheses, e.g. https://en.wikipedia.org/wiki/A_(b).
const INLINE_PATTERN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\((?:[^()\s]|\([^()\s]*\))+\))/g;

/** Only these link targets are rendered as links; anything else (javascript:, data:, ...) stays text. */
export function isSafeHref(href: string): boolean {
  if (href.startsWith('#') || href.startsWith('/')) return !href.startsWith('//');
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > last) out.push({ type: 'text', value: text.slice(last, index) });
    last = index + token.length;

    if (token.startsWith('`')) {
      out.push({ type: 'code', value: token.slice(1, -1) });
    } else if (token.startsWith('**')) {
      out.push({ type: 'strong', children: parseInline(token.slice(2, -2)) });
    } else {
      const split = token.indexOf('](');
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      out.push(
        isSafeHref(href)
          ? { type: 'link', href, children: parseInline(label) }
          : { type: 'text', value: label },
      );
    }
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: Inline[][] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ type: 'list', items: list });
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);

    if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: 'heading',
        level: (heading[1] ?? '#').length as 1 | 2 | 3 | 4,
        children: parseInline((heading[2] ?? '').trim()),
      });
    } else if (bullet) {
      flushParagraph();
      (list ??= []).push(parseInline((bullet[1] ?? '').trim()));
    } else if (list && /^\s{2,}\S/.test(raw)) {
      // Continuation line of the previous bullet.
      const last = list[list.length - 1];
      if (last) last.push(...parseInline(' ' + line.trim()));
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** Plain text of inline nodes, used for headings and ids. */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.type === 'text' || n.type === 'code' ? n.value : inlineText(n.children)))
    .join('');
}

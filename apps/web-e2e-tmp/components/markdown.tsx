import type { ReactNode } from 'react';
import type { Block, Inline } from '@/lib/markdown';

/**
 * Renders parsed markdown as React elements. Text is only ever passed as children, so React escapes
 * it; there is no HTML injection path. Link targets were already filtered by the parser.
 */
function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return node.value;
      case 'code':
        return <code key={i}>{node.value}</code>;
      case 'strong':
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case 'link': {
        const external = /^https?:/i.test(node.href);
        return (
          <a
            key={i}
            href={node.href}
            {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {renderInline(node.children)}
          </a>
        );
      }
    }
  });
}

export function Markdown({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'heading':
            return block.level >= 4 ? (
              <h4 key={i}>{renderInline(block.children)}</h4>
            ) : (
              <h3 key={i}>{renderInline(block.children)}</h3>
            );
          case 'paragraph':
            return <p key={i}>{renderInline(block.children)}</p>;
          case 'list':
            return (
              <ul key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{renderInline(item)}</li>
                ))}
              </ul>
            );
        }
      })}
    </>
  );
}

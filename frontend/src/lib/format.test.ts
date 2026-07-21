import { describe, it, expect } from 'vitest';
import { parseInline, toBlocks, InlineNode } from '@/lib/format';

/** Flatten a node tree back to the visible characters, dropping the marks. */
function plain(nodes: InlineNode[]): string {
  return nodes
    .map((n) => (n.type === 'text' ? n.value : plain(n.children)))
    .join('');
}

describe('parseInline', () => {
  it('leaves plain text untouched', () => {
    expect(parseInline('hello world')).toEqual([{ type: 'text', value: 'hello world' }]);
  });

  it('parses each mark', () => {
    expect(parseInline('**b**')).toEqual([
      { type: 'bold', children: [{ type: 'text', value: 'b' }] },
    ]);
    expect(parseInline('__i__')).toEqual([
      { type: 'italic', children: [{ type: 'text', value: 'i' }] },
    ]);
    expect(parseInline('~~s~~')).toEqual([
      { type: 'strike', children: [{ type: 'text', value: 's' }] },
    ]);
    expect(parseInline('||x||')).toEqual([
      { type: 'spoiler', children: [{ type: 'text', value: 'x' }] },
    ]);
  });

  it('nests different marks', () => {
    const nodes = parseInline('**bold __italic__**');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('bold');
    expect(plain(nodes)).toBe('bold italic');
    const inner = (nodes[0] as Extract<InlineNode, { type: 'bold' }>).children;
    expect(inner.some((n) => n.type === 'italic')).toBe(true);
  });

  it('treats an unmatched delimiter as literal', () => {
    expect(parseInline('a ** b')).toEqual([{ type: 'text', value: 'a ** b' }]);
  });

  it('treats an empty run as literal', () => {
    expect(parseInline('****')).toEqual([{ type: 'text', value: '****' }]);
    expect(parseInline('||||')).toEqual([{ type: 'text', value: '||||' }]);
  });

  it('keeps surrounding text', () => {
    expect(plain(parseInline('pre **mid** post'))).toBe('pre mid post');
  });
});

describe('toBlocks', () => {
  it('promotes # lines to headings and keeps their level', () => {
    const blocks = toBlocks('# Title\nbody');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    expect(blocks[1].type).toBe('text');
    expect(plain(blocks[0].children)).toBe('Title');
  });

  it('reads ## and ### levels', () => {
    expect(toBlocks('## two')[0]).toMatchObject({ type: 'heading', level: 2 });
    expect(toBlocks('### three')[0]).toMatchObject({ type: 'heading', level: 3 });
  });

  it('needs a space and visible text after the hashes', () => {
    expect(toBlocks('#nospace')[0].type).toBe('text');
    expect(toBlocks('#   ')[0].type).toBe('text');
    expect(toBlocks('#### four')[0].type).toBe('text');
  });

  it('keeps consecutive plain lines in one block', () => {
    const blocks = toBlocks('line one\n\nline three');
    expect(blocks).toHaveLength(1);
    expect(plain(blocks[0].children)).toBe('line one\n\nline three');
  });

  it('parses marks inside a heading', () => {
    const blocks = toBlocks('# a ||secret||');
    const spoiler = blocks[0].children.find((n) => n.type === 'spoiler');
    expect(spoiler).toBeTruthy();
  });
});

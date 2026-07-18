/**
 * Lightweight message formatting.
 *
 * A tiny, deliberately-bounded markdown dialect:
 *
 *   **bold**   __italic__   ~~strike~~   ||spoiler||   # heading
 *
 * The parser returns *data* -- a tree of nodes -- never markup. The renderer
 * turns each node into a React element, so peer-controlled text can no more
 * become HTML here than it could through `segmentize`: there is no
 * dangerouslySetInnerHTML anywhere near a message body. Link detection still
 * happens at the text leaves (see `segmentize`), so a URL inside **bold** is
 * still a real anchor.
 *
 * Nesting of *different* delimiters works (`**bold __and italic__**`); nesting a
 * delimiter inside itself does not, matching how Discord and CommonMark behave.
 * An unmatched or empty delimiter is left as literal text.
 */

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'bold'; children: InlineNode[] }
  | { type: 'italic'; children: InlineNode[] }
  | { type: 'strike'; children: InlineNode[] }
  | { type: 'spoiler'; children: InlineNode[] };

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; children: InlineNode[] }
  | { type: 'text'; children: InlineNode[] };

type InlineKind = Exclude<InlineNode['type'], 'text'>;

// Two-character paired delimiters. Order is irrelevant: a run is only ever
// matched against its own identical closer.
const DELIMITERS: Record<string, InlineKind> = {
  '**': 'bold',
  __: 'italic',
  '~~': 'strike',
  '||': 'spoiler',
};

/**
 * Parse inline markers into a node tree.
 *
 * Single left-to-right scan. At an opening delimiter we look for the next
 * identical delimiter; if one exists with non-empty content between, the inside
 * is parsed recursively (picking up any *other* nested markers) and emitted as a
 * node. Otherwise the two characters are literal and the scan advances by one,
 * so a lone `**` or an unmatched `||` renders as the characters typed.
 */
export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buf = '';
  let i = 0;

  const flush = () => {
    if (buf) {
      nodes.push({ type: 'text', value: buf });
      buf = '';
    }
  };

  while (i < text.length) {
    const pair = text.slice(i, i + 2);
    const kind = DELIMITERS[pair];

    if (kind) {
      const close = text.indexOf(pair, i + 2);
      // close > i + 2 rejects the empty run ("||||") -- nothing to hide, so it
      // is left as literal text rather than an empty box.
      if (close > i + 2) {
        flush();
        nodes.push({ type: kind, children: parseInline(text.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    buf += text[i];
    i += 1;
  }

  flush();
  return nodes;
}

const HEADING = /^(#{1,3})\s+(.*\S.*)$/;

/**
 * Split a body into block-level pieces.
 *
 * A line that starts with 1-3 `#` and has visible text after the space is a
 * heading; everything else is gathered into text blocks. Consecutive non-heading
 * lines stay in one block (rejoined with newlines) so `whitespace-pre-wrap`
 * keeps blank lines and soft wraps exactly as before -- headings are the only
 * thing that force a block boundary.
 */
export function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let run: string[] = [];

  const flush = () => {
    if (run.length) {
      blocks.push({ type: 'text', children: parseInline(run.join('\n')) });
      run = [];
    }
  };

  for (const line of text.split('\n')) {
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({
        type: 'heading',
        level: h[1].length as 1 | 2 | 3,
        children: parseInline(h[2]),
      });
    } else {
      run.push(line);
    }
  }

  flush();
  return blocks;
}

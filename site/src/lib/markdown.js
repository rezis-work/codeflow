// @ts-nocheck
/**
 * A small Markdown subset for the docs pages: headings, lists, tables,
 * fenced code, links, images, bold, and inline code. Content is authored
 * in this repo, and the renderer never emits raw HTML.
 */

/**
 * @param {string} value
 */
export function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'section';
}

/**
 * @param {string} source
 */
export function parseDocument(source) {
  const normalized = source.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  const front = readFrontmatter(normalized);
  const used = new Map();
  /** @type {import('./markdown.js').Block[]} */
  const blocks = [];
  /** @type {{ id: string, depth: number, text: string }[]} */
  const headings = [];
  const lines = front.body.split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }
    if (line.trim() === '---') {
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }
    const heading = /^(#{2,4})\s+(.+)$/.exec(line);
    if (heading?.[1] && heading[2]) {
      const depth = heading[1].length;
      const children = parseInline(heading[2].trim());
      const text = plain(children);
      let id = slugify(text);
      const seen = used.get(id) ?? 0;
      used.set(id, seen + 1);
      if (seen > 0) {
        id = `${id}-${seen + 1}`;
      }
      blocks.push({ type: 'heading', depth, id, children });
      headings.push({ id, depth, text });
      index += 1;
      continue;
    }
    if (line.startsWith('> ')) {
      const quote = [];
      while (index < lines.length && (lines[index] ?? '').startsWith('> ')) {
        quote.push((lines[index] ?? '').slice(2));
        index += 1;
      }
      blocks.push({ type: 'quote', children: parseInline(quote.join(' ')) });
      continue;
    }
    if (isTableStart(lines, index)) {
      const headers = splitRow(line);
      index += 2;
      /** @type {import('./markdown.js').Inline[][]} */
      const rows = [];
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('|')) {
        rows.push(splitRow(lines[index] ?? '').map((cell) => parseInline(cell)));
        index += 1;
      }
      blocks.push({
        type: 'table',
        headers: headers.map((cell) => parseInline(cell)),
        rows,
      });
      continue;
    }
    if (/^(?:- |\* |\d+\. )/.test(line)) {
      const ordered = /^\d+\. /.test(line);
      /** @type {import('./markdown.js').Inline[][]} */
      const items = [];
      while (index < lines.length && /^(?:- |\* |\d+\. )/.test(lines[index] ?? '')) {
        const item = (lines[index] ?? '').replace(/^(?:- |\* |\d+\. )/, '');
        items.push(parseInline(item));
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? '').trim() !== '' && !startsBlock(lines, index)) {
      paragraph.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ')) });
  }
  return {
    title: front.title,
    description: front.description,
    blocks,
    headings,
    text: [front.title, front.description, ...headings.map((heading) => heading.text), plainBlocks(blocks)]
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim(),
  };
}

/**
 * @param {string} source
 */
function readFrontmatter(source) {
  if (!source.startsWith('---\n')) {
    throw new Error('A docs page needs frontmatter.');
  }
  const end = source.indexOf('\n---\n', 4);
  if (end === -1) {
    throw new Error('Docs frontmatter is missing its closing marker.');
  }
  const raw = source.slice(4, end);
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of raw.split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match?.[1]) {
      continue;
    }
    fields[match[1]] = (match[2] ?? '').replace(/^"(.*)"$/, '$1').trim();
  }
  if (!fields.title || !fields.description) {
    throw new Error('Docs frontmatter needs title and description.');
  }
  return { title: fields.title, description: fields.description, body: source.slice(end + 5) };
}

/**
 * @param {string[]} lines
 * @param {number} index
 */
function startsBlock(lines, index) {
  const line = lines[index] ?? '';
  return (
    line.startsWith('```') ||
    line.startsWith('> ') ||
    line.trim() === '---' ||
    /^(#{2,4})\s+/.test(line) ||
    /^(?:- |\* |\d+\. )/.test(line) ||
    isTableStart(lines, index)
  );
}

/**
 * @param {string[]} lines
 * @param {number} index
 */
function isTableStart(lines, index) {
  const line = lines[index] ?? '';
  const next = lines[index + 1] ?? '';
  return line.trim().startsWith('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
}

/**
 * @param {string} line
 */
function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

/**
 * @param {string} input
 * @returns {import('./markdown.js').Inline[]}
 */
export function parseInline(input) {
  /** @type {import('./markdown.js').Inline[]} */
  const nodes = [];
  let buffer = '';
  const flush = () => {
    if (buffer.length > 0) {
      nodes.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };
  for (let index = 0; index < input.length; ) {
    if (input.startsWith('![', index)) {
      const parsed = readLink(input, index + 1);
      if (parsed) {
        flush();
        nodes.push({ type: 'image', alt: plain(parsed.children), href: parsed.href });
        index = parsed.next;
        continue;
      }
    }
    if (input[index] === '`') {
      const end = input.indexOf('`', index + 1);
      if (end !== -1) {
        flush();
        nodes.push({ type: 'code', text: input.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }
    if (input.startsWith('**', index)) {
      const end = input.indexOf('**', index + 2);
      if (end !== -1) {
        flush();
        nodes.push({ type: 'strong', children: parseInline(input.slice(index + 2, end)) });
        index = end + 2;
        continue;
      }
    }
    if (input[index] === '[') {
      const parsed = readLink(input, index);
      if (parsed) {
        flush();
        nodes.push({ type: 'link', href: parsed.href, children: parsed.children });
        index = parsed.next;
        continue;
      }
    }
    buffer += input[index];
    index += 1;
  }
  flush();
  return nodes;
}

/**
 * @param {string} input
 * @param {number} start
 */
function readLink(input, start) {
  if (input[start] !== '[') {
    return undefined;
  }
  const labelEnd = input.indexOf(']', start + 1);
  if (labelEnd === -1 || input[labelEnd + 1] !== '(') {
    return undefined;
  }
  const hrefEnd = input.indexOf(')', labelEnd + 2);
  if (hrefEnd === -1) {
    return undefined;
  }
  return {
    href: input.slice(labelEnd + 2, hrefEnd).trim(),
    children: parseInline(input.slice(start + 1, labelEnd)),
    next: hrefEnd + 1,
  };
}

/**
 * @param {import('./markdown.js').Inline[]} nodes
 */
function plain(nodes) {
  return nodes
    .map((node) => {
      if (node.type === 'text' || node.type === 'code') {
        return node.text;
      }
      if (node.type === 'image') {
        return node.alt;
      }
      return plain(node.children);
    })
    .join('');
}

/**
 * @param {import('./markdown.js').Block[]} blocks
 */
function plainBlocks(blocks) {
  return blocks
    .map((block) => {
      if (block.type === 'code') {
        return block.text;
      }
      if (block.type === 'hr') {
        return '';
      }
      if (block.type === 'list') {
        return block.items.map((item) => plain(item)).join(' ');
      }
      if (block.type === 'table') {
        return [...block.headers, ...block.rows.flat()].map((cell) => plain(cell)).join(' ');
      }
      return plain(block.children);
    })
    .join(' ');
}

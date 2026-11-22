import { parseDocument } from './markdown.js';
import type { Document, Heading } from './markdown.js';

const sources = import.meta.glob('./content/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export interface DocPage {
  readonly slug: string;
  readonly href: string;
  readonly title: string;
  readonly description: string;
  readonly group: string;
  readonly document: Document;
}

export interface DocGroup {
  readonly title: string;
  readonly pages: readonly DocPage[];
}

const order: readonly { readonly group: string; readonly slug: string; readonly href?: string }[] = [
  { group: 'Start', slug: 'overview', href: '/docs' },
  { group: 'Start', slug: 'getting-started' },
  { group: 'In the editor', slug: 'editor' },
  { group: 'In the editor', slug: 'diagrams' },
  { group: 'Automate', slug: 'cli' },
  { group: 'Automate', slug: 'github-action' },
  { group: 'Agents', slug: 'agents' },
  { group: 'Agents', slug: 'workflows' },
  { group: 'Reference', slug: 'configuration' },
  { group: 'Reference', slug: 'troubleshooting' },
  { group: 'Reference', slug: 'changelog' },
];

function pageFor(entry: (typeof order)[number]): DocPage {
  const key = `./content/${entry.slug}.md`;
  const source = sources[key];
  if (!source) {
    throw new Error(`Missing docs page ${entry.slug}.md`);
  }
  const document = parseDocument(source);
  return {
    slug: entry.slug,
    href: entry.href ?? `/docs/${entry.slug}`,
    title: document.title,
    description: document.description,
    group: entry.group,
    document,
  };
}

export const docPages: readonly DocPage[] = order.map(pageFor);

export const docGroups: readonly DocGroup[] = docPages.reduce<DocGroup[]>((groups, page) => {
  const current = groups.at(-1);
  if (!current || current.title !== page.group) {
    groups.push({ title: page.group, pages: [page] });
    return groups;
  }
  return [...groups.slice(0, -1), { title: current.title, pages: [...current.pages, page] }];
}, []);

export function findDoc(slug: string): DocPage | undefined {
  return docPages.find((page) => page.slug === slug);
}

export function searchDocs(query: string): readonly DocPage[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  return docPages
    .filter((page) => page.document.text.toLowerCase().includes(needle))
    .slice(0, 8);
}

export type { Heading };

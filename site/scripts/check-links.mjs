/**
 * Fail when a docs link, image, command, or setting is missing.
 * Run from site/: node scripts/check-links.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from '../src/lib/markdown.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '..');
const contentDir = path.join(root, 'src/lib/content');
const slugs = [
  'overview',
  'getting-started',
  'editor',
  'diagrams',
  'cli',
  'github-action',
  'agents',
  'workflows',
  'configuration',
  'troubleshooting',
  'changelog',
];

const pages = new Map();
for (const slug of slugs) {
  const file = path.join(contentDir, `${slug}.md`);
  const source = readFileSync(file, 'utf8');
  pages.set(slug, { source, doc: parseDocument(source), href: slug === 'overview' ? '/docs' : `/docs/${slug}` });
}

const errors = [];
const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

for (const [slug, page] of pages) {
  const ids = new Set(page.doc.headings.map((heading) => heading.id));
  for (const match of page.source.matchAll(linkPattern)) {
    const href = match[1];
    if (!href || href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
      continue;
    }
    if (href.startsWith('#')) {
      if (!ids.has(href.slice(1))) {
        errors.push(`${slug}: missing heading ${href}`);
      }
      continue;
    }
    if (!href.startsWith('/')) {
      errors.push(`${slug}: relative link ${href}`);
      continue;
    }
    const [pathname, hash] = href.split('#');
    if (pathname === '/docs' || pathname === '/docs/') {
      const overview = pages.get('overview');
      if (hash && !overview.doc.headings.some((heading) => heading.id === hash)) {
        errors.push(`${slug}: missing ${href}`);
      }
      continue;
    }
    const docsMatch = /^\/docs\/([a-z0-9-]+)\/?$/.exec(pathname);
    if (!docsMatch) {
      if (pathname.startsWith('/gallery/')) {
        if (!existsSync(path.join(root, 'static', pathname))) {
          errors.push(`${slug}: missing image ${pathname}`);
        }
        continue;
      }
      errors.push(`${slug}: unknown site path ${pathname}`);
      continue;
    }
    const target = pages.get(docsMatch[1]);
    if (!target) {
      errors.push(`${slug}: unknown docs page ${pathname}`);
      continue;
    }
    if (hash && !target.doc.headings.some((heading) => heading.id === hash)) {
      errors.push(`${slug}: missing ${href}`);
    }
  }
}

const manifest = JSON.parse(readFileSync(path.join(repo, 'packages/extension/package.json'), 'utf8'));
const editor = pages.get('editor').source;
for (const command of manifest.contributes.commands) {
  if (!editor.includes(command.title.replace(/^CodeFlow: /, ''))) {
    errors.push(`editor.md is missing command ${command.title}`);
  }
}

const configuration = pages.get('configuration').source;
const sections = Array.isArray(manifest.contributes.configuration)
  ? manifest.contributes.configuration
  : [manifest.contributes.configuration];
for (const section of sections) {
  for (const key of Object.keys(section.properties ?? {})) {
    if (!configuration.includes(`\`${key}\``)) {
      errors.push(`configuration.md is missing ${key}`);
    }
  }
}

const landing = readFileSync(path.join(root, 'src/routes/+page.svelte'), 'utf8');
const header = readFileSync(path.join(root, 'src/lib/components/SiteHeader.svelte'), 'utf8');
const footer = readFileSync(path.join(root, 'src/lib/components/SiteFooter.svelte'), 'utf8');
for (const file of [landing, header, footer]) {
  for (const match of file.matchAll(/href="(\/docs[^"]*)"/g)) {
    const href = match[1];
    const [pathname, hash] = href.split('#');
    const slug = pathname === '/docs' ? 'overview' : pathname.replace('/docs/', '');
    const target = pages.get(slug);
    if (!target) {
      errors.push(`svelte link missing page ${href}`);
      continue;
    }
    if (hash && !target.doc.headings.some((heading) => heading.id === hash)) {
      errors.push(`svelte link missing heading ${href}`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Checked ${pages.size} docs pages, commands, and settings.`);

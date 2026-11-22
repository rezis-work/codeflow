<script lang="ts">
  import type { DocPage } from '../docs.ts';
  import Markdown from './Markdown.svelte';

  let { page, origin }: { page: DocPage; origin: string } = $props();
  const canonical = $derived(`${origin}${page.href}`);
  const pageTitle = $derived(`${page.title} — Rezis CodeFlow`);
</script>

<svelte:head>
  <title>{pageTitle}</title>
  <meta name="description" content={page.description} />
  <link rel="canonical" href={canonical} />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="Rezis CodeFlow" />
  <meta property="og:title" content={pageTitle} />
  <meta property="og:description" content={page.description} />
  <meta property="og:url" content={canonical} />
  <meta property="og:image" content="{origin}/og.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={pageTitle} />
  <meta name="twitter:description" content={page.description} />
  <meta name="twitter:image" content="{origin}/og.png" />
</svelte:head>

<article class="doc-article">
  <p class="kicker">Docs</p>
  <h1>{page.title}</h1>
  <p class="lede">{page.description}</p>
  {#if page.document.headings.length > 0}
    <details class="toc-mobile">
      <summary>On this page</summary>
      <nav aria-label="On this page">
        <ol>
          {#each page.document.headings as heading (heading.id)}
            <li class:toc-sub={heading.depth > 2}>
              <a href="#{heading.id}">{heading.text}</a>
            </li>
          {/each}
        </ol>
      </nav>
    </details>
  {/if}
  <Markdown blocks={page.document.blocks} />
</article>

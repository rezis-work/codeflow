<script lang="ts">
  import { page } from '$app/state';
  import { docGroups, docPages, searchDocs } from '#lib/docs.ts';
  import SiteFooter from '#lib/components/SiteFooter.svelte';
  import SiteHeader from '#lib/components/SiteHeader.svelte';

  let { children }: { children: import('svelte').Snippet } = $props();
  let query = $state('');
  let menuOpen = $state(false);
  const matches = $derived(searchDocs(query));
  const current = $derived(page.url.pathname.replace(/\/$/, '') || '/docs');
  const currentPage = $derived(docPages.find((item) => item.href === current));

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') menuOpen = false;
  }
</script>

<svelte:window onkeydown={onKeydown} />

<SiteHeader />
<div class="wrap docs-shell">
  <div class="docs-toolbar">
    <button
      type="button"
      class="docs-menu"
      aria-expanded={menuOpen}
      aria-controls="docs-menu"
      onclick={() => (menuOpen = !menuOpen)}
    >
      {menuOpen ? 'Close docs' : 'Docs menu'}
    </button>
  </div>
  {#if menuOpen}
    <button type="button" class="docs-scrim" aria-label="Close docs menu" onclick={() => (menuOpen = false)}></button>
  {/if}
  <aside id="docs-menu" class="docs-nav" class:open={menuOpen}>
    <div class="docs-nav-head">
      <p class="docs-group">Docs</p>
      <button type="button" class="docs-close" onclick={() => (menuOpen = false)}>Close</button>
    </div>
    <form role="search" onsubmit={(event) => event.preventDefault()}>
      <label class="sr-only" for="docs-search">Search docs</label>
      <input id="docs-search" type="search" placeholder="Search docs" bind:value={query} />
    </form>
    {#if query.trim().length > 0}
      <ul class="search-hits">
        {#each matches as hit (hit.href)}
          <li>
            <a href={hit.href} onclick={() => (menuOpen = false)}>{hit.title}</a>
          </li>
        {:else}
          <li class="muted">No matching page.</li>
        {/each}
      </ul>
    {/if}
    {#each docGroups as group (group.title)}
      <p class="docs-group">{group.title}</p>
      <ul>
        {#each group.pages as item (item.href)}
          <li>
            <a
              href={item.href}
              aria-current={current === item.href ? 'page' : undefined}
              onclick={() => (menuOpen = false)}>{item.title}</a
            >
          </li>
        {/each}
      </ul>
    {/each}
  </aside>
  <div class="docs-main">
    {@render children()}
  </div>
  {#if currentPage && currentPage.document.headings.length > 0}
    <nav class="docs-toc" aria-label="On this page">
      <p>On this page</p>
      <ol>
        {#each currentPage.document.headings as heading (heading.id)}
          <li class:toc-sub={heading.depth > 2}>
            <a href="{currentPage.href}#{heading.id}">{heading.text}</a>
          </li>
        {/each}
      </ol>
    </nav>
  {/if}
</div>
<SiteFooter />

<script lang="ts">
  import { marketplaceUrl, repoUrl } from '../content.ts';

  let { brandHref = '/' }: { brandHref?: string } = $props();
  let open = $state(false);

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') open = false;
  }
</script>

<svelte:window onkeydown={onKeydown} />

<header class="wrap">
  <nav class="nav" aria-label="Primary">
    <a class="brand" href={brandHref} onclick={() => (open = false)}>
      <img src="/icon.svg" width="36" height="36" alt="" />
      <span>Rezis CodeFlow</span>
    </a>
    <button
      type="button"
      class="nav-toggle"
      aria-expanded={open}
      aria-controls="primary-menu"
      onclick={() => (open = !open)}
    >
      <span class="nav-toggle-bars" aria-hidden="true"></span>
      <span class="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
    </button>
    <div id="primary-menu" class="nav-links" class:open>
      <a href="/#features" onclick={() => (open = false)}>Features</a>
      <a href="/#agents" onclick={() => (open = false)}>Agents</a>
      <a href="/#start" onclick={() => (open = false)}>Get started</a>
      <a href="/docs" onclick={() => (open = false)}>Docs</a>
      <a href={repoUrl} onclick={() => (open = false)}>GitHub</a>
      <a class="btn btn-primary" href={marketplaceUrl} onclick={() => (open = false)}>Install</a>
    </div>
  </nav>
</header>

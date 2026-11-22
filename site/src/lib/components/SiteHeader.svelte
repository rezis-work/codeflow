<script lang="ts">
  import { marketplaceUrl, repoUrl } from '../content.ts';

  let { brandHref = '/' }: { brandHref?: string } = $props();
</script>

<header class="wrap">
  <nav class="nav" aria-label="Primary">
    <a class="brand" href={brandHref}>
      <img src="/icon.svg" width="36" height="36" alt="" />
      Rezis CodeFlow
    </a>
    <div class="nav-links">
      <a href="/#features">Features</a>
      <a href="/#agents">Agents</a>
      <a href="/#start">Get started</a>
      <a class="nav-keep" href="/docs">Docs</a>
      <a href={repoUrl}>GitHub</a>
      <a class="btn btn-primary" href={marketplaceUrl}>Install</a>
    </div>
  </nav>
</header>

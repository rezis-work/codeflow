<script lang="ts">
  import { licenseUrl, marketplaceUrl, openVsxUrl, releaseUrl, repoUrl } from '../content.ts';
</script>

<footer class="wrap">
  <div class="foot">
    <p>© 2026 rezis-work. <a href={licenseUrl}>MIT License</a>.</p>
    <nav aria-label="Footer">
      <a href="/docs">Docs</a>
      <a href={repoUrl}>GitHub</a>
      <a href={marketplaceUrl}>VS Code Marketplace</a>
      <a href={openVsxUrl}>Open VSX</a>
      <a href={releaseUrl}>Latest release</a>
    </nav>
  </div>
</footer>

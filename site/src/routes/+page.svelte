<script lang="ts">
  import CallGraph from '#lib/components/CallGraph.svelte';
  import CopyButton from '#lib/components/CopyButton.svelte';
  import Flowchart from '#lib/components/Flowchart.svelte';
  import SequenceDiagram from '#lib/components/SequenceDiagram.svelte';
  import TraitMap from '#lib/components/TraitMap.svelte';
  import {
    cliInstall,
    extInstall,
    faqs,
    features,
    licenseUrl,
    marketplaceUrl,
    openVsxUrl,
    releaseUrl,
    repoUrl,
    shots,
    steps,
  } from '#lib/content.ts';
  import { reveal } from '#lib/reveal.ts';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>{data.title}</title>
  <meta name="description" content={data.description} />
  <link rel="canonical" href="{data.origin}/" />
  <link rel="icon" href="/favicon.png" type="image/png" />
  <link rel="icon" href="/icon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Rezis CodeFlow" />
  <meta property="og:title" content={data.title} />
  <meta property="og:description" content={data.description} />
  <meta property="og:url" content="{data.origin}/" />
  <meta property="og:image" content="{data.origin}/og.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="Rezis CodeFlow. See how your code runs, beside the code." />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={data.title} />
  <meta name="twitter:description" content={data.description} />
  <meta name="twitter:image" content="{data.origin}/og.png" />
  <meta name="twitter:image:alt" content="Rezis CodeFlow. See how your code runs, beside the code." />
  {@html `<script type="application/ld+json">${data.jsonLd}</script>`}
</svelte:head>

<header class="wrap">
  <nav class="nav" aria-label="Primary">
    <a class="brand" href="#content">
      <img src="/icon.svg" width="36" height="36" alt="" />
      Rezis CodeFlow
    </a>
    <div class="nav-links">
      <a href="#features">Features</a>
      <a href="#how">How it works</a>
      <a href="#faq">FAQ</a>
      <a href={repoUrl}>GitHub</a>
      <a class="btn btn-primary" href={marketplaceUrl}>Install</a>
    </div>
  </nav>
</header>

<main id="content">
  <div class="wrap hero">
    <div>
      <p class="kicker">VS Code and Cursor</p>
      <h1>Rezis CodeFlow</h1>
      <p class="pitch">See how your code runs, beside the code.</p>
      <p class="lede">
        Call graphs, flowcharts, sequence diagrams, Rust trait maps, and request traces for
        TypeScript, JavaScript, and Rust. Analysis stays on your machine. There is no telemetry.
      </p>
      <div class="actions">
        <a class="btn btn-primary" href={marketplaceUrl}>Install for VS Code</a>
        <a class="btn btn-primary" href={openVsxUrl}>Install for Cursor / Open VSX</a>
        <a class="btn btn-secondary" href={repoUrl}>GitHub</a>
        <a class="btn btn-secondary" href={releaseUrl}>Download .vsix</a>
      </div>
      <div class="commands">
        <div class="command">
          <code>{cliInstall}</code>
          <CopyButton text={cliInstall} label="Copy the code install command" />
        </div>
        <div class="command">
          <code>{extInstall}</code>
          <CopyButton text={extInstall} label="Copy the editor install command" />
        </div>
      </div>
      <p class="note">Extension id <code>rezis-work.rezis-codeflow</code>. The .vsix is on the latest GitHub Release.</p>
    </div>
    <figure class="frame">
      <div class="frame-bar">
        <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>sample.ts</span>
        <span class="frame-tag">call graph + trace</span>
      </div>
      <CallGraph />
      <ul class="legend">
        <li><span><i class="swatch"></i> Certain</span></li>
        <li><span><i class="swatch dashed"></i> Uncertain</span></li>
        <li><span><i class="swatch trace">1</i> Trace order</span></li>
      </ul>
      <figcaption class="caption">
        Illustration of <code>greet</code> calling <code>format</code> in the repository fixture
        <code>sample.ts</code>. The numbers are the runtime-trace order.
      </figcaption>
    </figure>
  </div>

  <section class="wrap" id="features" use:reveal>
    <h2>What it draws</h2>
    <p class="section-intro">
      One symbol, the calls around it, and the path through a function. TypeScript, JavaScript, and
      Rust. Analysis stays on your machine.
    </p>
    <ul class="langs">
      <li>TypeScript</li>
      <li>JavaScript</li>
      <li>Rust</li>
      <li>Local analysis, no telemetry</li>
    </ul>
    <div class="features" style="margin-top: 22px">
      {#each features as feature (feature.title)}
        <article class="card">
          <h3>{feature.title}</h3>
          <p>{feature.body}</p>
        </article>
      {/each}
    </div>
  </section>

  <section class="wrap" id="views" use:reveal>
    <h2>The views</h2>
    <p class="section-intro">
      Illustrations of diagrams the extension already draws from fixtures in this repository. The
      pictures under them are the screenshots from the README.
    </p>
    <div class="views">
      <figure class="frame">
        <div class="frame-bar">
          <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <span>functions.ts</span>
          <span class="frame-tag">flowchart</span>
        </div>
        <Flowchart />
        <figcaption class="caption">
          Illustration of the control-flow flowchart for <code>branch</code>: null, then admin, then
          the user string.
        </figcaption>
      </figure>
      <figure class="frame">
        <div class="frame-bar">
          <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <span>sample.ts</span>
          <span class="frame-tag">sequence</span>
        </div>
        <SequenceDiagram />
        <figcaption class="caption">
          Illustration of the function-call sequence: greet calls format, and format returns the
          greeting.
        </figcaption>
      </figure>
      <figure class="frame">
        <div class="frame-bar">
          <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <span>shapes</span>
          <span class="frame-tag">trait map</span>
        </div>
        <TraitMap />
        <figcaption class="caption">
          Illustration of a Rust trait map from the shapes fixture: Shape extends Draw, and Circle
          implements it.
        </figcaption>
      </figure>
    </div>
  </section>

  <section class="wrap" use:reveal>
    <h2>From the repository</h2>
    <p class="section-intro">The same pictures published in the project README.</p>
    <div class="shots">
      {#each shots as shot (shot.src)}
        <figure>
          <img
            src={shot.src}
            width={shot.width}
            height={shot.height}
            alt={shot.alt}
            loading="lazy"
            decoding="async"
          />
          <figcaption>{shot.alt}</figcaption>
        </figure>
      {/each}
    </div>
  </section>

  <section class="wrap" id="how" use:reveal>
    <h2>How it works</h2>
    <ol class="steps">
      {#each steps as step (step.title)}
        <li>
          <div>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </div>
        </li>
      {/each}
    </ol>
  </section>

  <section class="wrap faq" id="faq" use:reveal>
    <h2>FAQ</h2>
    {#each faqs as item (item.q)}
      <details>
        <summary>{item.q}</summary>
        <p>{item.a}</p>
      </details>
    {/each}
  </section>

  <section class="wrap" use:reveal>
    <div class="cta">
      <div>
        <h2>Put the diagram beside the code.</h2>
        <p>Free. MIT licensed. Nothing is uploaded.</p>
      </div>
      <div class="actions">
        <a class="btn btn-primary" href={marketplaceUrl}>Install for VS Code</a>
        <a class="btn btn-primary" href={openVsxUrl}>Install for Cursor / Open VSX</a>
      </div>
    </div>
  </section>
</main>

<footer class="wrap">
  <div class="foot">
    <p>© 2026 rezis-work. <a href={licenseUrl}>MIT License</a>.</p>
    <nav aria-label="Footer">
      <a href={repoUrl}>GitHub</a>
      <a href={marketplaceUrl}>VS Code Marketplace</a>
      <a href={openVsxUrl}>Open VSX</a>
      <a href={releaseUrl}>Latest release</a>
    </nav>
  </div>
</footer>

<svg
  viewBox="0 0 420 210"
  role="img"
  aria-label="Sequence diagram: greet calls format, and format returns Hello."
>
  <defs>
    <marker
      id="sq-arrow"
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="6"
      markerHeight="6"
      orient="auto-start-reverse"
    >
      <path d="M0 0 L10 5 L0 10 z" class="arrow-head" />
    </marker>
    <marker
      id="sq-return"
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="6"
      markerHeight="6"
      orient="auto-start-reverse"
    >
      <path d="M0 0 L10 5 L0 10 z" class="return-head" />
    </marker>
  </defs>
  <line class="life" x1="90" y1="72" x2="90" y2="198" />
  <line class="life" x1="320" y1="72" x2="320" y2="198" />
  <g class="node" style="animation-delay: 0.05s">
    <rect x="28" y="16" width="124" height="48" rx="14" />
    <text class="node-title" x="90" y="46" text-anchor="middle">greet</text>
  </g>
  <g class="node" style="animation-delay: 0.2s">
    <rect x="258" y="16" width="124" height="48" rx="14" />
    <text class="node-title" x="320" y="46" text-anchor="middle">format</text>
  </g>
  <line
    class="draw edge"
    pathLength="1"
    x1="90"
    y1="110"
    x2="308"
    y2="110"
    marker-end="url(#sq-arrow)"
    style="animation-delay: 0.45s"
  />
  <text class="edge-label" x="200" y="102" text-anchor="middle">format(name)</text>
  <line
    class="fade-edge edge dashed"
    x1="308"
    y1="168"
    x2="102"
    y2="168"
    marker-end="url(#sq-return)"
    style="animation-delay: 0.9s"
  />
  <text class="edge-label" x="200" y="160" text-anchor="middle">Hello, {'{name}'}</text>
</svg>

import { EDGE_KINDS } from '@codeflow/shared';
import { EDGE_KIND_LABEL, edgeColor } from './appearance';

export function Legend() {
  return (
    <footer className="legend" aria-label="Diagram legend">
      <ul>
        {EDGE_KINDS.map((kind) => (
          <li key={kind}>
            <span className="legend-swatch" style={{ background: edgeColor(kind) }} />
            {EDGE_KIND_LABEL[kind]}
          </li>
        ))}
        <li>
          <span className="legend-swatch legend-swatch-dashed" />
          Inferred or uncertain
        </li>
      </ul>
      <p className="legend-note">
        A dashed edge is inferred, or uncertain because the receiver is dyn Trait, a generic bound,
        impl Trait, or could not be named. Hover the edge for the reason. An inherited default is
        dashed too.
      </p>
    </footer>
  );
}

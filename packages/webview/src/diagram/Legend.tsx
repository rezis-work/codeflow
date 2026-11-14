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
        A dashed edge is inferred, or uncertain. Uncertain calls are a callback or other
        higher-order function, dependency injection, dynamic dispatch (including dyn Trait), a
        generic bound (including impl Trait), a macro, or a dynamic property or computed call. Hover
        the edge for the reason. An inherited default is dashed too. Turn off Uncertain to hide
        those edges.
      </p>
    </footer>
  );
}

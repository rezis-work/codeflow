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
          Inferred
        </li>
      </ul>
    </footer>
  );
}

import type {
  DiagramTheme,
  SequenceDiagram,
  SequenceGranularity,
  SequenceMessage,
  SourceLocation,
} from '@codeflow/shared';
import { uncertaintyTooltip } from '@codeflow/shared';
import { layoutSequence } from './sequenceLayout';

const GRANULARITIES: readonly { readonly id: SequenceGranularity; readonly label: string }[] = [
  { id: 'file', label: 'File' },
  { id: 'type', label: 'Type' },
  { id: 'module', label: 'Module' },
];

export function SequenceView(props: {
  readonly diagram: SequenceDiagram;
  readonly theme?: DiagramTheme;
  readonly onReveal: (location: SourceLocation) => void;
  readonly onBack: () => void;
  readonly onGranularity: (granularity: SequenceGranularity) => void;
}) {
  const { diagram, theme, onReveal, onBack, onGranularity } = props;
  const layout = layoutSequence(diagram);
  const participants = new Map(
    diagram.participants.map((participant) => [participant.id, participant]),
  );
  const messages = new Map(diagram.messages.map((message) => [message.id, message]));

  return (
    <div
      className="sequence"
      data-testid="sequence-view"
      data-theme={theme ?? 'dark'}
      data-granularity={diagram.granularity}
    >
      <nav className="flow-crumb sequence-toolbar" aria-label="Sequence">
        <button type="button" onClick={onBack}>
          Graph
        </button>
        <div className="toolbar-group" role="group" aria-label="Lifeline granularity">
          {GRANULARITIES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={diagram.granularity === item.id}
              onClick={() => {
                onGranularity(item.id);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="sequence-title">{diagram.title}</p>
      </nav>
      {diagram.truncated ? (
        <p className="sequence-truncated" role="status" data-testid="sequence-truncated">
          {diagram.note ?? 'Truncated.'}
        </p>
      ) : null}
      {diagram.messages.length === 0 ? (
        <p className="sequence-empty" data-testid="sequence-empty">
          No calls from this symbol.
        </p>
      ) : (
        <p className="sequence-key">
          Calls run downward. A dashed call is uncertain. A thin dashed arrow is the return.
        </p>
      )}
      <div className="sequence-scroll">
        <div className="sequence-stage" style={{ width: layout.width, height: layout.height }}>
          {layout.lifelines.map((lifeline) => {
            const participant = participants.get(lifeline.id);
            const location = participant?.location;
            return (
              <button
                key={lifeline.id}
                type="button"
                className="sequence-head"
                style={{ left: lifeline.x - 70 }}
                data-kind={lifeline.kind}
                aria-label={lifeline.note ? `${lifeline.label}, ${lifeline.note}` : lifeline.label}
                disabled={!location}
                onClick={() => {
                  if (location) {
                    onReveal(location);
                  }
                }}
              >
                <span className="sequence-head-label">{lifeline.label}</span>
                {lifeline.note ? <span className="sequence-head-note">{lifeline.note}</span> : null}
              </button>
            );
          })}
          <svg
            className="sequence-svg"
            width={layout.width}
            height={layout.height}
            role="img"
            aria-label={`${diagram.title} sequence`}
          >
            {layout.frames.map((frame) => (
              <g key={frame.id} className="sequence-frame" data-kind={frame.kind}>
                <rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} rx={4} />
                <text x={frame.x + 8} y={frame.y + 14}>
                  {frame.kind} [{clip(frame.label, 42)}]
                </text>
              </g>
            ))}
            {layout.lifelines.map((lifeline) => (
              <line
                key={lifeline.id}
                className="sequence-lifeline"
                x1={lifeline.x}
                x2={lifeline.x}
                y1={58}
                y2={layout.height - 8}
              />
            ))}
            {layout.activations.map((activation) => (
              <rect
                key={activation.id}
                className="sequence-activation"
                data-depth={activation.depth}
                x={activation.x}
                y={activation.y}
                width={activation.width}
                height={activation.height}
                rx={2}
              />
            ))}
            {layout.messages.map((message) => {
              const source = messages.get(message.id);
              const location = source?.location;
              const tip = tooltip(message.label, source, message.recursive);
              return (
                <g
                  key={message.id}
                  className="sequence-message"
                  data-kind={message.kind}
                  data-uncertain={message.uncertain ? 'true' : 'false'}
                  data-self={message.self ? 'true' : 'false'}
                  data-testid={`sequence-message-${message.id}`}
                  role={location ? 'button' : undefined}
                  tabIndex={location ? 0 : undefined}
                  aria-label={tip}
                  onClick={() => {
                    if (location) {
                      onReveal(location);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (!location || (event.key !== 'Enter' && event.key !== ' ')) {
                      return;
                    }
                    event.preventDefault();
                    onReveal(location);
                  }}
                >
                  <title>{tip}</title>
                  {message.self ? (
                    <path
                      d={`M ${message.x1} ${message.y} h ${SEQUENCE_HOOK} v 12 h ${-SEQUENCE_HOOK}`}
                      markerEnd=""
                    />
                  ) : (
                    <line
                      x1={message.x1}
                      y1={message.y}
                      x2={arrowBase(message.x1, message.x2)}
                      y2={message.y}
                    />
                  )}
                  <polygon points={arrowPoints(message.x1, message.x2, message.y, message.self)} />
                  <text
                    x={message.self ? message.x1 + 8 : (message.x1 + message.x2) / 2}
                    y={message.y - 6}
                    textAnchor={message.self ? 'start' : 'middle'}
                  >
                    {message.kind === 'return' ? '' : clip(message.label, 28)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}

const SEQUENCE_HOOK = 36;

function arrowBase(x1: number, x2: number): number {
  if (x1 === x2) {
    return x2;
  }
  const dir = x2 > x1 ? 1 : -1;
  return x2 - dir * 8;
}

function arrowPoints(x1: number, x2: number, y: number, self: boolean): string {
  if (self) {
    const tip = x1;
    const base = x1 + 8;
    return `${tip},${y + 12} ${base},${y + 8} ${base},${y + 16}`;
  }
  const dir = x2 >= x1 ? 1 : -1;
  const tip = x2;
  const base = x2 - dir * 8;
  return `${tip},${y} ${base},${y - 4} ${base},${y + 4}`;
}

function tooltip(label: string, source: SequenceMessage | undefined, recursive: boolean): string {
  const parts = [label];
  const reason = source ? reasonTooltip(source) : undefined;
  if (reason) {
    parts.push(reason);
  }
  if (recursive) {
    parts.push('recursive');
  }
  return parts.join(' · ');
}

/** The call-graph reason, when the message has one. Otherwise the stored note. */
function reasonTooltip(message: SequenceMessage): string | undefined {
  if (message.reason) {
    return uncertaintyTooltip({ reason: message.reason, uncertain: true });
  }
  return uncertaintyTooltip({
    ...(message.detail ? { detail: message.detail } : {}),
    ...(message.uncertain ? { uncertain: true } : {}),
  });
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

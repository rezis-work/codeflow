import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { SymbolFlowNode } from './toFlow';

/** Single click opens the symbol. The expand control asks for its neighbours. */
export function SymbolNodeView({ data }: NodeProps<SymbolFlowNode>) {
  return (
    <div
      className="code-node"
      data-kind={data.kind}
      data-type-kind={data.typeKind}
      data-language={data.language}
      data-focused={data.focused ? 'true' : 'false'}
      data-testid="symbol-node"
    >
      <Handle type="target" position={Position.Left} />
      <button
        type="button"
        className="code-node-open"
        aria-label={`${data.kindLabel} ${data.title}`}
        onClick={(event) => {
          event.stopPropagation();
          data.onReveal(data.location);
        }}
      >
        <span className="code-node-kicker">
          <span className="code-badge">{data.kindLabel}</span>
          <span className="code-badge code-badge-lang">{data.languageBadge}</span>
        </span>
        <span className="code-node-title">{data.title}</span>
        {data.detail ? <span className="code-node-detail">{data.detail}</span> : null}
      </button>
      <button
        type="button"
        className="code-node-expand nodrag nopan"
        aria-label={`Expand ${data.title}`}
        title="Show neighbours"
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          data.onExpand(data.nodeId);
        }}
      >
        +
      </button>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

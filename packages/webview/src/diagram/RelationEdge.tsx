import { getSmoothStepPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { RelationFlowEdge } from './toFlow';

export function RelationEdge(props: EdgeProps<RelationFlowEdge>) {
  const [path] = getSmoothStepPath(props);
  const tooltip = props.data?.tooltip;
  const className = [
    'react-flow__edge-path',
    props.data?.incident ? 'is-incident' : '',
    props.data?.dimmed ? 'is-dimmed' : '',
  ]
    .filter((part) => part.length > 0)
    .join(' ');
  return (
    <path
      id={props.id}
      d={path}
      className={className}
      style={props.style}
      markerEnd={props.markerEnd}
      data-kind={props.data?.kind}
      data-confidence={props.data?.confidence}
      data-uncertain={props.data?.uncertain ? 'true' : 'false'}
      data-reason={props.data?.reason}
      data-testid={`edge-${props.data?.kind ?? 'link'}`}
    >
      {tooltip ? <title>{tooltip}</title> : null}
    </path>
  );
}

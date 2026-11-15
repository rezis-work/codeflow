/**
 * Places a sequence diagram in rows and columns.
 *
 * Lifelines stand side by side. Message `order` is the row. This is not an
 * ELK graph layout: nothing is ranked or crossed over. Nested activations
 * shift a few pixels to the right so a self-call stays visible.
 */

import type { SequenceDiagram, SequenceMessage } from '@codeflow/shared';

export const SEQUENCE_LANE = 176;
export const SEQUENCE_ROW = 46;
export const SEQUENCE_HEAD = 72;
export const SEQUENCE_PAD = 28;
export const SEQUENCE_SELF = 44;

export interface PlacedLifeline {
  readonly id: string;
  readonly x: number;
  readonly label: string;
  readonly note?: string;
  readonly kind: string;
}

export interface PlacedMessage {
  readonly id: string;
  readonly kind: SequenceMessage['kind'];
  readonly label: string;
  readonly x1: number;
  readonly x2: number;
  readonly y: number;
  readonly self: boolean;
  readonly uncertain: boolean;
  readonly detail?: string;
  readonly recursive: boolean;
}

export interface PlacedActivation {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

export interface PlacedFrame {
  readonly id: string;
  readonly kind: 'loop' | 'alt';
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SequenceLayout {
  readonly width: number;
  readonly height: number;
  readonly lifelines: readonly PlacedLifeline[];
  readonly messages: readonly PlacedMessage[];
  readonly activations: readonly PlacedActivation[];
  readonly frames: readonly PlacedFrame[];
}

export function layoutSequence(diagram: SequenceDiagram): SequenceLayout {
  const lifelines = diagram.participants.map((participant, index) => ({
    id: participant.id,
    x: SEQUENCE_PAD + index * SEQUENCE_LANE + SEQUENCE_LANE / 2,
    label: participant.label,
    ...(participant.note ? { note: participant.note } : {}),
    kind: participant.kind,
  }));
  const at = new Map(lifelines.map((lifeline) => [lifeline.id, lifeline.x]));
  const rowCount = Math.max(1, diagram.messages.length);
  const width = SEQUENCE_PAD * 2 + Math.max(1, lifelines.length) * SEQUENCE_LANE;
  const height = SEQUENCE_HEAD + rowCount * SEQUENCE_ROW + 24;
  const messages = diagram.messages.map((message) => {
    const x1 = at.get(message.from) ?? SEQUENCE_PAD;
    const x2 = at.get(message.to) ?? x1;
    const self = message.from === message.to;
    return {
      id: message.id,
      kind: message.kind,
      label: message.label,
      x1,
      x2: self ? x1 + SEQUENCE_SELF : x2,
      y: rowY(message.order),
      self,
      uncertain: message.uncertain === true,
      ...(message.detail ? { detail: message.detail } : {}),
      recursive: message.recursive === true,
    };
  });
  const activations = diagram.activations.flatMap((activation) => {
    const center = at.get(activation.participant);
    if (center === undefined) {
      return [];
    }
    const shift = Math.min(activation.depth, 4) * 8;
    const top = rowY(activation.start) - 12;
    const bottom = rowY(activation.end) + 12;
    return [
      {
        id: activation.id,
        x: center - 5 + shift,
        y: top,
        width: 10,
        height: Math.max(16, bottom - top),
        depth: activation.depth,
      },
    ];
  });
  const frames = diagram.frames.flatMap((frame) => {
    const covered = diagram.messages.filter(
      (message) => message.order >= frame.start && message.order <= frame.end,
    );
    const xs = covered.flatMap((message) => {
      const from = at.get(message.from);
      const to = at.get(message.to);
      if (from === undefined) {
        return [];
      }
      if (message.from === message.to) {
        return [from - 16, from + SEQUENCE_SELF + 12];
      }
      return [from, to ?? from];
    });
    if (xs.length === 0) {
      return [];
    }
    const left = Math.max(8, Math.min(...xs) - 28);
    const right = Math.min(width - 8, Math.max(...xs) + 28);
    const top = rowY(frame.start) - 20;
    const bottom = rowY(frame.end) + 18;
    return [
      {
        id: frame.id,
        kind: frame.kind,
        label: frame.label,
        x: left,
        y: top,
        width: Math.max(24, right - left),
        height: Math.max(28, bottom - top),
      },
    ];
  });
  return { width, height, lifelines, messages, activations, frames };
}

function rowY(order: number): number {
  return SEQUENCE_HEAD + order * SEQUENCE_ROW + SEQUENCE_ROW / 2;
}

/**
 * A sequence diagram for one traced path.
 *
 * Participants are lifelines. Messages run top to bottom: a call, the calls
 * it makes, then a return. Activations are the bars on a lifeline. A frame
 * groups messages that sit inside one loop or branch. Payload version is
 * {@link SEQUENCE_VERSION}. A parser that does not know a version rejects
 * the diagram.
 *
 * The layout is not a graph layout. `order` is the vertical position.
 */

import { isLanguage, isNonEmptyString, isNonNegativeInteger, isRecord } from './ids';
import type { Language } from './ids';
import { isUncertaintyReason, parseSourceLocation, parsed, rejected } from './graph';
import type { ParseResult, SourceLocation, UncertaintyReason } from './graph';

export const SEQUENCE_VERSION = 1 as const;

/** Call messages kept in one diagram. The builder stops and sets `truncated`. */
export const SEQUENCE_MESSAGE_LIMIT = 80;

/** Deepest call step a sequence will walk. Matches the call-depth setting. */
export const SEQUENCE_DEPTH_LIMIT = 32;

export const SEQUENCE_GRANULARITIES = ['file', 'type', 'module'] as const;
export type SequenceGranularity = (typeof SEQUENCE_GRANULARITIES)[number];

export const SEQUENCE_SOURCES = ['call', 'request'] as const;
export type SequenceSource = (typeof SEQUENCE_SOURCES)[number];

export const SEQUENCE_PARTICIPANT_KINDS = [
  'file',
  'type',
  'module',
  'function',
  'route',
  'sink',
] as const;
export type SequenceParticipantKind = (typeof SEQUENCE_PARTICIPANT_KINDS)[number];

export const SEQUENCE_MESSAGE_KINDS = ['call', 'return'] as const;
export type SequenceMessageKind = (typeof SEQUENCE_MESSAGE_KINDS)[number];

export const SEQUENCE_FRAME_KINDS = ['loop', 'alt'] as const;
export type SequenceFrameKind = (typeof SEQUENCE_FRAME_KINDS)[number];

export const SEQUENCE_ERROR_CODES = ['not-found', 'not-a-function', 'internal'] as const;
export type SequenceErrorCode = (typeof SEQUENCE_ERROR_CODES)[number];

/** One lifeline. `type` is a class, impl, struct, enum, or trait. */
export interface SequenceParticipant {
  readonly id: string;
  readonly kind: SequenceParticipantKind;
  readonly label: string;
  /** `class`, `impl`, `crate`, `file`, or another short role. */
  readonly note?: string;
  readonly language?: Language;
  readonly location?: SourceLocation;
}

/**
 * One arrow. `order` is its row, starting at 0. `depth` is how many calls
 * are open around it. A return uses the depth of the call it closes.
 */
export interface SequenceMessage {
  readonly id: string;
  readonly kind: SequenceMessageKind;
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly order: number;
  readonly depth: number;
  readonly uncertain?: boolean;
  /** The same category the call graph uses for this uncertain call. */
  readonly reason?: UncertaintyReason;
  readonly detail?: string;
  readonly location?: SourceLocation;
  /** The callee is already on the stack. Its body is not drawn again. */
  readonly recursive?: boolean;
}

/** The bar on a lifeline from message `start` through message `end`, inclusive. */
export interface SequenceActivation {
  readonly id: string;
  readonly participant: string;
  readonly start: number;
  readonly end: number;
  /** 0 is the outermost bar on that lifeline. Nested calls increment it. */
  readonly depth: number;
}

/**
 * A loop or a branch drawn around the messages it contains.
 * `alt` is one frame for the whole decision, not a separate else compartment.
 */
export interface SequenceFrame {
  readonly id: string;
  readonly kind: SequenceFrameKind;
  readonly label: string;
  readonly start: number;
  readonly end: number;
  readonly location?: SourceLocation;
}

export interface SequenceDiagram {
  readonly version: typeof SEQUENCE_VERSION;
  readonly title: string;
  readonly granularity: SequenceGranularity;
  readonly source: SequenceSource;
  readonly participants: readonly SequenceParticipant[];
  readonly messages: readonly SequenceMessage[];
  readonly activations: readonly SequenceActivation[];
  readonly frames: readonly SequenceFrame[];
  /** The builder stopped at the call depth or the message cap. */
  readonly truncated?: boolean;
  /** Why the diagram stopped, when {@link truncated} is set. */
  readonly note?: string;
}

const ID_LIMIT = 200;
const LABEL_LIMIT = 160;
const TITLE_LIMIT = 200;
const NOTE_LIMIT = 240;
const PARTICIPANT_LIMIT = 200;

export function isSequenceGranularity(value: unknown): value is SequenceGranularity {
  return typeof value === 'string' && (SEQUENCE_GRANULARITIES as readonly string[]).includes(value);
}

export function isSequenceErrorCode(value: unknown): value is SequenceErrorCode {
  return typeof value === 'string' && (SEQUENCE_ERROR_CODES as readonly string[]).includes(value);
}

export function parseSequenceDiagram(value: unknown): ParseResult<SequenceDiagram> {
  if (!isRecord(value)) {
    return rejected('A sequence diagram must be an object.');
  }
  if (value.version !== SEQUENCE_VERSION) {
    return rejected('Unsupported sequence version.');
  }
  if (!isNonEmptyString(value.title) || value.title.length > TITLE_LIMIT) {
    return rejected('A sequence needs a title.');
  }
  if (!isSequenceGranularity(value.granularity)) {
    return rejected('Sequence granularity is not supported.');
  }
  if (!isSequenceSource(value.source)) {
    return rejected('Sequence source is not supported.');
  }
  const participants = parseParticipants(value.participants);
  if (!participants.ok) {
    return participants;
  }
  const ids = new Set(participants.value.map((participant) => participant.id));
  const messages = parseMessages(value.messages, ids);
  if (!messages.ok) {
    return messages;
  }
  const orders = messages.value.length;
  const activations = parseActivations(value.activations, ids, orders);
  if (!activations.ok) {
    return activations;
  }
  const frames = parseFrames(value.frames, orders);
  if (!frames.ok) {
    return frames;
  }
  if (value.truncated !== undefined && typeof value.truncated !== 'boolean') {
    return rejected('truncated must be a boolean.');
  }
  const note = readNote(value.note);
  if (!note.ok) {
    return note;
  }
  return parsed({
    version: SEQUENCE_VERSION,
    title: value.title,
    granularity: value.granularity,
    source: value.source,
    participants: participants.value,
    messages: messages.value,
    activations: activations.value,
    frames: frames.value,
    ...(value.truncated === true ? { truncated: true } : {}),
    ...(note.value ? { note: note.value } : {}),
  });
}

function parseParticipants(value: unknown): ParseResult<readonly SequenceParticipant[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > PARTICIPANT_LIMIT) {
    return rejected('A sequence needs at least one participant.');
  }
  const participants: SequenceParticipant[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const participant = parseParticipant(item);
    if (!participant.ok) {
      return participant;
    }
    if (seen.has(participant.value.id)) {
      return rejected('Participant ids must be unique.');
    }
    seen.add(participant.value.id);
    participants.push(participant.value);
  }
  return parsed(participants);
}

function parseParticipant(value: unknown): ParseResult<SequenceParticipant> {
  if (!isRecord(value)) {
    return rejected('A participant must be an object.');
  }
  if (!isShortId(value.id) || !isParticipantKind(value.kind)) {
    return rejected('A participant needs an id and a kind.');
  }
  if (!isNonEmptyString(value.label) || value.label.length > LABEL_LIMIT) {
    return rejected('A participant needs a label.');
  }
  const note = readLimited(value.note, LABEL_LIMIT, 'note');
  if (!note.ok) {
    return note;
  }
  if (value.language !== undefined && !isLanguage(value.language)) {
    return rejected('Participant language is not supported.');
  }
  let location: SourceLocation | undefined;
  if (value.location !== undefined) {
    const parsedLocation = parseSourceLocation(value.location);
    if (!parsedLocation.ok) {
      return parsedLocation;
    }
    location = parsedLocation.value;
  }
  return parsed({
    id: value.id,
    kind: value.kind,
    label: value.label,
    ...(note.value ? { note: note.value } : {}),
    ...(isLanguage(value.language) ? { language: value.language } : {}),
    ...(location ? { location } : {}),
  });
}

function parseMessages(
  value: unknown,
  participants: ReadonlySet<string>,
): ParseResult<readonly SequenceMessage[]> {
  if (!Array.isArray(value) || value.length > SEQUENCE_MESSAGE_LIMIT * 2) {
    return rejected('Sequence messages are missing or too long.');
  }
  const messages: SequenceMessage[] = [];
  const seen = new Set<string>();
  const orders = new Set<number>();
  for (const item of value) {
    const message = parseMessage(item, participants);
    if (!message.ok) {
      return message;
    }
    if (seen.has(message.value.id) || orders.has(message.value.order)) {
      return rejected('Message ids and orders must be unique.');
    }
    seen.add(message.value.id);
    orders.add(message.value.order);
    messages.push(message.value);
  }
  for (let order = 0; order < messages.length; order += 1) {
    if (!orders.has(order)) {
      return rejected('Message orders must be contiguous from 0.');
    }
  }
  messages.sort((left, right) => left.order - right.order);
  return parsed(messages);
}

function parseMessage(
  value: unknown,
  participants: ReadonlySet<string>,
): ParseResult<SequenceMessage> {
  if (!isRecord(value)) {
    return rejected('A sequence message must be an object.');
  }
  if (!isShortId(value.id) || !isMessageKind(value.kind)) {
    return rejected('A sequence message needs an id and a kind.');
  }
  if (
    !isNonEmptyString(value.from) ||
    !participants.has(value.from) ||
    !isNonEmptyString(value.to) ||
    !participants.has(value.to)
  ) {
    return rejected('A sequence message must join two participants.');
  }
  if (!isNonEmptyString(value.label) || value.label.length > LABEL_LIMIT) {
    return rejected('A sequence message needs a label.');
  }
  if (!isNonNegativeInteger(value.order) || !isNonNegativeInteger(value.depth)) {
    return rejected('A sequence message needs an order and a depth.');
  }
  if (value.depth > SEQUENCE_DEPTH_LIMIT) {
    return rejected('Sequence message depth is too large.');
  }
  if (value.uncertain !== undefined && typeof value.uncertain !== 'boolean') {
    return rejected('uncertain must be a boolean.');
  }
  if (value.reason !== undefined && !isUncertaintyReason(value.reason)) {
    return rejected('Sequence uncertainty reason is not supported.');
  }
  if (value.reason !== undefined && value.uncertain !== true) {
    return rejected('A sequence message with a reason is uncertain.');
  }
  if (value.recursive !== undefined && typeof value.recursive !== 'boolean') {
    return rejected('recursive must be a boolean.');
  }
  const detail = readLimited(value.detail, LABEL_LIMIT, 'detail');
  if (!detail.ok) {
    return detail;
  }
  let location: SourceLocation | undefined;
  if (value.location !== undefined) {
    const parsedLocation = parseSourceLocation(value.location);
    if (!parsedLocation.ok) {
      return parsedLocation;
    }
    location = parsedLocation.value;
  }
  return parsed({
    id: value.id,
    kind: value.kind,
    from: value.from,
    to: value.to,
    label: value.label,
    order: value.order,
    depth: value.depth,
    ...(value.uncertain === true ? { uncertain: true } : {}),
    ...(isUncertaintyReason(value.reason) ? { reason: value.reason } : {}),
    ...(detail.value ? { detail: detail.value } : {}),
    ...(location ? { location } : {}),
    ...(value.recursive === true ? { recursive: true } : {}),
  });
}

function parseActivations(
  value: unknown,
  participants: ReadonlySet<string>,
  orders: number,
): ParseResult<readonly SequenceActivation[]> {
  if (!Array.isArray(value) || value.length > PARTICIPANT_LIMIT * 4) {
    return rejected('Sequence activations are missing or too long.');
  }
  if (orders === 0 && value.length > 0) {
    return rejected('An empty sequence has no activations.');
  }
  const activations: SequenceActivation[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !isShortId(item.id) || !isNonEmptyString(item.participant)) {
      return rejected('An activation needs an id and a participant.');
    }
    if (!participants.has(item.participant)) {
      return rejected('An activation points at a missing participant.');
    }
    if (
      !isNonNegativeInteger(item.start) ||
      !isNonNegativeInteger(item.end) ||
      !isNonNegativeInteger(item.depth)
    ) {
      return rejected('An activation needs a start, an end, and a depth.');
    }
    if (item.start > item.end || item.end >= orders || item.depth > SEQUENCE_DEPTH_LIMIT) {
      return rejected('An activation is outside the sequence.');
    }
    if (seen.has(item.id)) {
      return rejected('Activation ids must be unique.');
    }
    seen.add(item.id);
    activations.push({
      id: item.id,
      participant: item.participant,
      start: item.start,
      end: item.end,
      depth: item.depth,
    });
  }
  return parsed(activations);
}

function parseFrames(value: unknown, orders: number): ParseResult<readonly SequenceFrame[]> {
  if (!Array.isArray(value) || value.length > SEQUENCE_MESSAGE_LIMIT) {
    return rejected('Sequence frames are missing or too long.');
  }
  if (orders === 0 && value.length > 0) {
    return rejected('An empty sequence has no frames.');
  }
  const frames: SequenceFrame[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !isShortId(item.id) || !isFrameKind(item.kind)) {
      return rejected('A frame needs an id and a kind.');
    }
    if (!isNonEmptyString(item.label) || item.label.length > LABEL_LIMIT) {
      return rejected('A frame needs a label.');
    }
    if (!isNonNegativeInteger(item.start) || !isNonNegativeInteger(item.end)) {
      return rejected('A frame needs a start and an end.');
    }
    if (item.start > item.end || item.end >= orders) {
      return rejected('A frame is outside the sequence.');
    }
    if (seen.has(item.id)) {
      return rejected('Frame ids must be unique.');
    }
    seen.add(item.id);
    let location: SourceLocation | undefined;
    if (item.location !== undefined) {
      const parsedLocation = parseSourceLocation(item.location);
      if (!parsedLocation.ok) {
        return parsedLocation;
      }
      location = parsedLocation.value;
    }
    frames.push({
      id: item.id,
      kind: item.kind,
      label: item.label,
      start: item.start,
      end: item.end,
      ...(location ? { location } : {}),
    });
  }
  return parsed(frames);
}

function readNote(value: unknown): ParseResult<string | undefined> {
  return readLimited(value, NOTE_LIMIT, 'note');
}

function readLimited(value: unknown, limit: number, name: string): ParseResult<string | undefined> {
  if (value === undefined) {
    return parsed(undefined);
  }
  if (typeof value !== 'string' || value.length > limit) {
    return rejected(`${name} is too long.`);
  }
  const trimmed = value.trim();
  return parsed(trimmed.length > 0 ? trimmed : undefined);
}

function isShortId(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= ID_LIMIT;
}

function isSequenceSource(value: unknown): value is SequenceSource {
  return typeof value === 'string' && (SEQUENCE_SOURCES as readonly string[]).includes(value);
}

function isParticipantKind(value: unknown): value is SequenceParticipantKind {
  return (
    typeof value === 'string' && (SEQUENCE_PARTICIPANT_KINDS as readonly string[]).includes(value)
  );
}

function isMessageKind(value: unknown): value is SequenceMessageKind {
  return typeof value === 'string' && (SEQUENCE_MESSAGE_KINDS as readonly string[]).includes(value);
}

function isFrameKind(value: unknown): value is SequenceFrameKind {
  return typeof value === 'string' && (SEQUENCE_FRAME_KINDS as readonly string[]).includes(value);
}

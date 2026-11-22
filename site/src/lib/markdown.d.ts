export type Inline =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'strong'; readonly children: readonly Inline[] }
  | { readonly type: 'link'; readonly href: string; readonly children: readonly Inline[] }
  | { readonly type: 'image'; readonly alt: string; readonly href: string };

export type Block =
  | { readonly type: 'heading'; readonly depth: number; readonly id: string; readonly children: readonly Inline[] }
  | { readonly type: 'paragraph'; readonly children: readonly Inline[] }
  | { readonly type: 'list'; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] }
  | { readonly type: 'code'; readonly lang: string; readonly text: string }
  | {
      readonly type: 'table';
      readonly headers: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    }
  | { readonly type: 'quote'; readonly children: readonly Inline[] }
  | { readonly type: 'hr' };

export interface Heading {
  readonly id: string;
  readonly depth: number;
  readonly text: string;
}

export interface Document {
  readonly title: string;
  readonly description: string;
  readonly blocks: readonly Block[];
  readonly headings: readonly Heading[];
  readonly text: string;
}

export function slugify(value: string): string;
export function parseDocument(source: string): Document;
export function parseInline(input: string): Inline[];

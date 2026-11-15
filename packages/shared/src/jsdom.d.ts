declare module 'jsdom' {
  export class JSDOM {
    constructor(html: string, options?: { pretendToBeVisual?: boolean });
    readonly window: {
      document: object;
      DOMParser: unknown;
      HTMLElement: unknown;
      SVGElement: unknown;
      Element: unknown;
      Node: unknown;
      getComputedStyle: (element: object) => object;
    };
  }
}

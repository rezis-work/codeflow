class ResizeObserverStub implements ResizeObserver {
  public constructor(private readonly callback: ResizeObserverCallback) {}

  public observe(target: Element): void {
    this.callback(
      [
        {
          target,
          contentRect: {
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            bottom: 64,
            right: 180,
            width: 180,
            height: 64,
            toJSON(): object {
              return {};
            },
          },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      this,
    );
  }

  public unobserve(): void {}

  public disconnect(): void {}
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  value: ResizeObserverStub,
  writable: true,
});

if (typeof HTMLElement !== 'undefined') {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return 180;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return 64;
    },
  });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 64,
      right: 180,
      width: 180,
      height: 64,
      toJSON(): object {
        return {};
      },
    }) as DOMRect;
}

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener(): void {},
      removeEventListener(): void {},
      addListener(): void {},
      removeListener(): void {},
      dispatchEvent(): boolean {
        return false;
      },
    }),
    writable: true,
  });
}

if (typeof globalThis.DOMMatrixReadOnly === 'undefined') {
  class DOMMatrixReadOnlyStub {
    public m22 = 1;
    public constructor() {}
  }
  Object.defineProperty(globalThis, 'DOMMatrixReadOnly', {
    value: DOMMatrixReadOnlyStub,
    writable: true,
  });
}

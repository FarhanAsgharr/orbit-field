/**
 * Test environment shims.
 *
 * jsdom implements neither `matchMedia` nor `ResizeObserver`, and both are
 * touched during render — matchMedia by the reduced-motion query, ResizeObserver
 * by Recharts' responsive container. Without these, every render throws before
 * a single assertion runs.
 */

import '@testing-library/jest-dom/vitest';

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

// jsdom has no layout engine, so Recharts measures 0×0 and renders nothing.
// Giving the container real dimensions lets chart markup actually appear.
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 900 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });

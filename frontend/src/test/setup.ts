import { afterEach, vi } from 'vitest';

/**
 * NOTE on crypto tests and realms.
 *
 * Under jsdom, TextEncoder is polyfilled from Node and hands back typed arrays
 * built in Node's realm, while the `Uint8Array` global is jsdom's. libsodium
 * checks `instanceof Uint8Array` and rejects everything with "unsupported input
 * type for message". Browsers have one realm, so this is purely an artifact of
 * the test environment -- not a bug in the app.
 *
 * The fix is per-file rather than a global shim: anything touching libsodium
 * declares `@vitest-environment node` (it needs no DOM anyway), and component
 * tests keep jsdom. Forcing Node's typed arrays onto the jsdom global instead
 * would "fix" crypto by breaking every DOM API that expects jsdom's.
 *
 * This file runs for BOTH environments, so every DOM shim below is guarded.
 */
const isDom = typeof window !== 'undefined';

if (isDom) {
  // Dynamic: these import jsdom-only globals at module scope and would throw in
  // the node environment.
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');

  afterEach(() => {
    cleanup();
    // Guarded: recent Node exposes its own experimental `localStorage` that can
    // shadow jsdom's, and it is undefined unless --localstorage-file is passed.
    globalThis.localStorage?.clear();
    globalThis.sessionStorage?.clear();
  });

  /**
   * jsdom has no layout engine, so every element reports height 0. The
   * composer's auto-grow reads scrollHeight to decide when to stop growing, so
   * without a stand-in that behaviour cannot be tested at all. Approximates
   * ~20px per line at ~40 characters per line.
   */
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      const value = String(this.value ?? '');
      const explicit = value.split('\n').length;
      const wrapped = Math.ceil(value.length / 40);
      return Math.max(explicit, wrapped, 1) * 20 + 16;
    },
  });

  // Not implemented in jsdom; the reply-jump calls it.
  Element.prototype.scrollIntoView = vi.fn();

  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  }
  if (!navigator.vibrate) {
    Object.defineProperty(navigator, 'vibrate', { value: vi.fn(), configurable: true });
  }

  // jsdom's PointerEvent lacks the fields the long-press handler reads.
  if (typeof window.PointerEvent === 'undefined') {
    class PointerEventShim extends MouseEvent {
      pointerType: string;
      pointerId: number;
      constructor(type: string, props: PointerEventInit = {}) {
        super(type, props);
        this.pointerType = props.pointerType ?? 'mouse';
        this.pointerId = props.pointerId ?? 1;
      }
    }
    // @ts-expect-error -- deliberate test shim
    window.PointerEvent = PointerEventShim;
  }

  if (!URL.createObjectURL) {
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
  }
}

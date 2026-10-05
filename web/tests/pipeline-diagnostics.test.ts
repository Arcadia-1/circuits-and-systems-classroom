import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureBrowserIssues } from '../src/illustrations/pipeline-intro/diagnostics';

describe('pipeline diagnostic lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal('window', new EventTarget());
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each([true, false])('cleans overlapping islands in either disposal order (first first: %s)', firstFirst => {
    const original = console.error;
    const first = captureBrowserIssues(), second = captureBrowserIssues();
    try {
      console.error('shared error');
      expect(first.issues).toHaveLength(1);
      expect(second.issues).toHaveLength(1);
      const disposed = firstFirst ? first : second, active = firstFirst ? second : first;
      disposed.dispose();
      console.error('active island error');
      expect(disposed.issues).toHaveLength(1);
      expect(active.issues).toHaveLength(2);
      active.dispose();
      expect(console.error).toBe(original);
      console.error('after navigation');
      expect(active.issues).toHaveLength(2);
      expect(original).toHaveBeenCalledTimes(3);
    } finally { first.dispose(); second.dispose(); }
  });

  it('records bounded errors and unhandled rejections and removes both listeners', () => {
    const capture = captureBrowserIssues();
    try {
      for (let index = 0; index < 40; index++) console.error(`error ${index}`);
      expect(capture.issues).toHaveLength(30);
      expect(capture.issues[0].message).toBe('error 10');
      window.dispatchEvent(Object.assign(new Event('error'), { message: 'window error' }));
      window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'rejected' }));
      expect(capture.issues.slice(-2).map(issue => [issue.kind, issue.message])).toEqual([
        ['error', 'window error'], ['unhandledrejection', 'rejected'],
      ]);
      const saved = [...capture.issues];
      capture.dispose();
      window.dispatchEvent(Object.assign(new Event('error'), { message: 'after disposal' }));
      window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'after disposal' }));
      expect(capture.issues).toEqual(saved);
    } finally { capture.dispose(); }
  });

  it('preserves a later console observer and leaves a disposed collector inactive', () => {
    const original = console.error, first = captureBrowserIssues();
    const inner = console.error;
    const laterObserver = vi.fn((...args: unknown[]) => inner(...args));
    console.error = laterObserver;
    first.dispose();
    expect(console.error).toBe(laterObserver);
    const second = captureBrowserIssues();
    try {
      console.error('only the current collector');
      expect(first.issues).toHaveLength(0);
      expect(second.issues).toHaveLength(1);
      expect(laterObserver).toHaveBeenCalledOnce();
      expect(original).toHaveBeenCalledOnce();
      second.dispose();
      expect(console.error).toBe(laterObserver);
    } finally { second.dispose(); console.error = original; }
  });
});

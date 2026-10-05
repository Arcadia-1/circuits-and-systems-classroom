export interface BrowserIssue {
  kind: 'error' | 'unhandledrejection' | 'console.error';
  message: string;
  at: string;
}

type ConsoleSink = (values: unknown[]) => void;
let consoleCapture: { sinks: Set<ConsoleSink>; previous: typeof console.error; wrapper: typeof console.error } | undefined;

function subscribeConsole(sink: ConsoleSink): () => void {
  if (!consoleCapture) {
    const sinks = new Set<ConsoleSink>(), previous = console.error;
    const wrapper: typeof console.error = (...values: unknown[]) => {
      for (const subscriber of sinks) subscriber(values);
      previous.apply(console, values);
    };
    consoleCapture = { sinks, previous, wrapper };
    console.error = wrapper;
  }
  // Islands can overlap during client navigation and dispose in either order.
  const capture = consoleCapture;
  capture.sinks.add(sink);
  return () => {
    capture.sinks.delete(sink);
    if (capture.sinks.size === 0) {
      if (console.error === capture.wrapper) console.error = capture.previous;
      if (consoleCapture === capture) consoleCapture = undefined;
    }
  };
}

/** Bounded, local-only diagnostics; disposed with the lesson island. */
export function captureBrowserIssues() {
  const issues: BrowserIssue[] = [];
  const describe = (value: unknown): string => {
    if (value instanceof Error) return value.stack ?? value.message;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value) ?? String(value); }
    catch { return String(value); }
  };
  const add = (kind: BrowserIssue['kind'], message: string) => {
    issues.push({ kind, message: message.slice(0, 4000), at: new Date().toISOString() });
    if (issues.length > 30) issues.shift();
  };
  const onError = (event: ErrorEvent) => add('error', describe(event.error ?? event.message));
  const onRejection = (event: PromiseRejectionEvent) => add('unhandledrejection', describe(event.reason));
  const unsubscribeConsole = subscribeConsole(values => add('console.error', values.map(describe).join(' ')));
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return {
    issues,
    dispose() {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      unsubscribeConsole();
    },
  };
}

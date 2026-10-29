// An in-memory stand-in for `tracing` from cloudflare:workers, for tests that
// assert what reaches a trace. Use it with vi.mock('cloudflare:workers').

/**
 * @typedef {{
 *   name: string,
 *   attributes: Record<string, string | number | boolean>,
 *   exceptions: unknown[],
 *   status: {code: string, message?: string} | undefined,
 *   ended: boolean,
 * }} RecordedSpan
 */

/**
 * @param {string} name
 * @returns {RecordedSpan & Record<string, any>}
 */
function createSpan(name) {
  /** @type {RecordedSpan & Record<string, any>} */
  const span = {
    name,
    attributes: {},
    exceptions: [],
    status: undefined,
    ended: false,
    isTraced: true,
    setAttribute(key, value) {
      span.attributes[key] = value;
      return span;
    },
    setAttributes(attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        if (value !== undefined) span.attributes[key] = value;
      }
      return span;
    },
    recordException(exception) {
      span.exceptions.push(exception);
    },
    setStatus(status) {
      span.status = status;
      return span;
    },
    updateName(next) {
      span.name = next;
      return span;
    },
    end() {
      span.ended = true;
    },
  };
  return span;
}

/**
 * A fake tracer with one active root span. `spans` lists every span created
 * through it, the root first.
 */
export function createTracingRecorder() {
  const root = createSpan('root');
  const spans = [root];
  const tracing = {
    getActiveSpan: () => root,
    /** @param {string} name */
    startSpan(name) {
      const span = createSpan(name);
      spans.push(span);
      return span;
    },
  };
  return { tracing, root, spans };
}

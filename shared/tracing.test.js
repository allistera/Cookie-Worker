import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createTracingRecorder } from '../test/fixtures/tracing-recorder.js';

const recorder = vi.hoisted(() => ({ current: /** @type {any} */ (null) }));

vi.mock('cloudflare:workers', () => ({
  tracing: {
    getActiveSpan: () => recorder.current?.tracing.getActiveSpan(),
    /** @param {string} name */
    startSpan: (name) => recorder.current?.tracing.startSpan(name),
  },
}));

const {
  activeSpan,
  endSpanWithError,
  errorType,
  labelRequestSpan,
  recordHandledError,
  routeTemplate,
  setSpanAttributes,
  startSpan,
} = await import('./tracing.js');

beforeEach(() => {
  recorder.current = createTracingRecorder();
});

describe('routeTemplate', () => {
  test.each([
    ['/health', '/health'],
    ['/', '/'],
    ['', '/'],
    ['/messages/7f3a1c2e-9b4d-4e8f-a1b2-c3d4e5f6a7b8/labels', '/messages/{id}/labels'],
    ['/tasks/42', '/tasks/{id}'],
    ['/r/a5196cd9bce0430c1234.gif', '/r/{id}.gif'],
    ['/documents/dGhpcy1pcy1hLXRva2Vu-1234567/pages', '/documents/{id}/pages'],
    ['/calendar-subscriptions', '/calendar-subscriptions'],
    ['/compose-preferences/default', '/compose-preferences/default'],
  ])('%s becomes %s', (pathname, route) => {
    expect(routeTemplate(pathname)).toBe(route);
  });

  test('caps a runaway path', () => {
    expect(routeTemplate(`/${'z'.repeat(400)}`)).toHaveLength(201);
  });
});

describe('errorType', () => {
  test('prefers a code, then the class, then the OpenTelemetry fallback', () => {
    expect(errorType(Object.assign(new Error('x'), { code: '23505' }))).toBe('23505');
    expect(errorType(Object.assign(new Error('x'), { code: 502 }))).toBe('502');
    expect(errorType(new TypeError('x'))).toBe('TypeError');
    expect(errorType('plain')).toBe('_OTHER');
    expect(errorType(undefined)).toBe('_OTHER');
  });
});

describe('span helpers', () => {
  test('write to the active span only while it is traced', () => {
    setSpanAttributes({ 'cookie.request.retried': true, skipped: undefined });
    expect(recorder.current.root.attributes).toEqual({ 'cookie.request.retried': true });

    recorder.current.root.isTraced = false;
    expect(activeSpan()).toBeUndefined();
    setSpanAttributes({ ignored: 1 });
    expect(startSpan('SELECT')).toBeUndefined();
    expect(recorder.current.root.attributes).toEqual({ 'cookie.request.retried': true });
  });

  test('are no-ops without any invocation', () => {
    recorder.current = null;
    expect(activeSpan()).toBeUndefined();
    expect(() => setSpanAttributes({ a: 1 })).not.toThrow();
    expect(startSpan('SELECT')).toBeUndefined();
    expect(() => labelRequestSpan(new Request('https://w.test/x'))).not.toThrow();
    expect(() => recordHandledError(new Error('x'), 'op')).not.toThrow();
  });

  test('startSpan creates a child with attributes', () => {
    const span = /** @type {any} */ (
      startSpan('SELECT', { 'db.system.name': 'postgresql', none: undefined })
    );
    expect(span.name).toBe('SELECT');
    expect(recorder.current.spans[1].attributes).toEqual({ 'db.system.name': 'postgresql' });
  });

  test('labelRequestSpan names the invocation after its route', () => {
    labelRequestSpan(
      new Request('https://w.test/messages/7f3a1c2e-9b4d-4e8f-a1b2-c3d4e5f6a7b8?token=s'),
    );
    expect(recorder.current.root.name).toBe('GET /messages/{id}');
    expect(recorder.current.root.attributes).toEqual({ 'http.route': '/messages/{id}' });
  });

  test('recordHandledError attaches the exception without failing the span', () => {
    const error = Object.assign(new Error('upload refused'), { code: 'ECONNRESET' });
    recordHandledError(error, 'attachment_upload');
    const { root } = recorder.current;
    expect(root.exceptions).toEqual([
      { name: 'Error', message: 'upload refused', stack: error.stack },
    ]);
    expect(root.attributes).toEqual({
      'error.type': 'ECONNRESET',
      'cookie.error.operation': 'attachment_upload',
    });
    expect(root.status).toBeUndefined();
  });

  test('endSpanWithError marks and ends the span', () => {
    const span = /** @type {any} */ (startSpan('UPDATE'));
    endSpanWithError(span, Object.assign(new Error('deadlock detected'), { code: '40P01' }));
    expect(span.status).toEqual({ code: 'error', message: '40P01' });
    expect(span.attributes['error.type']).toBe('40P01');
    expect(span.exceptions[0]).toMatchObject({ message: 'deadlock detected' });
    expect(span.ended).toBe(true);

    const other = /** @type {any} */ (startSpan('SELECT'));
    endSpanWithError(other, 'not an error object');
    expect(other.status).toEqual({ code: 'error', message: '_OTHER' });
    expect(other.exceptions[0]).toMatchObject({ message: 'not an error object' });
  });
});

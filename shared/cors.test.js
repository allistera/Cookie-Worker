import { describe, expect, test } from 'vitest';
import { corsHeaders, isAllowedOrigin, preflightResponse, withCors } from './cors.js';

const PRODUCTION = 'https://mail.infinitywave.online';

describe('isAllowedOrigin', () => {
  test('allows the exact production origin', () => {
    expect(isAllowedOrigin(PRODUCTION, PRODUCTION)).toBe(true);
  });

  test('allows any localhost port for local dev', () => {
    expect(isAllowedOrigin('http://localhost:5173', PRODUCTION)).toBe(true);
    expect(isAllowedOrigin('http://localhost:8787', PRODUCTION)).toBe(true);
  });

  test('allows any https Vercel preview subdomain', () => {
    expect(isAllowedOrigin('https://cookie-abc123-allisteras-projects.vercel.app', PRODUCTION)).toBe(true);
  });

  test('rejects an http Vercel-looking origin (not actually https)', () => {
    expect(isAllowedOrigin('http://cookie-abc123-allisteras-projects.vercel.app', PRODUCTION)).toBe(false);
  });

  test('rejects an unrelated origin', () => {
    expect(isAllowedOrigin('https://evil.example.com', PRODUCTION)).toBe(false);
  });

  test('rejects a missing origin', () => {
    expect(isAllowedOrigin(null, PRODUCTION)).toBe(false);
  });

  test('rejects an unparseable origin', () => {
    expect(isAllowedOrigin('not-a-url', PRODUCTION)).toBe(false);
  });
});

describe('corsHeaders', () => {
  test('returns headers naming the allowed origin', () => {
    const headers = corsHeaders(PRODUCTION, PRODUCTION);
    expect(headers?.['Access-Control-Allow-Origin']).toBe(PRODUCTION);
    expect(headers?.['Access-Control-Allow-Methods']).toContain('PATCH');
    expect(headers?.Vary).toBe('Origin');
  });

  test('returns null for a disallowed origin', () => {
    expect(corsHeaders('https://evil.example.com', PRODUCTION)).toBeNull();
  });
});

describe('preflightResponse', () => {
  test('answers an allowed origin with 204 and CORS headers', async () => {
    const response = preflightResponse(PRODUCTION, PRODUCTION);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PRODUCTION);
  });

  test('answers a disallowed origin with 403 and no CORS headers', async () => {
    const response = preflightResponse('https://evil.example.com', PRODUCTION);
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('withCors', () => {
  test('adds CORS headers to an allowed origin while preserving status and body', async () => {
    const original = Response.json({ ok: true }, { status: 201 });
    const wrapped = withCors(original, PRODUCTION, PRODUCTION);
    expect(wrapped.status).toBe(201);
    expect(wrapped.headers.get('Access-Control-Allow-Origin')).toBe(PRODUCTION);
    expect(await wrapped.json()).toEqual({ ok: true });
  });

  test('leaves a disallowed-origin response unchanged', () => {
    const original = Response.json({ ok: true }, { status: 200 });
    const wrapped = withCors(original, 'https://evil.example.com', PRODUCTION);
    expect(wrapped.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

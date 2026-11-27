import { supportsReasoning } from './enrichmentSettings.js';
import { fetchWithTimeout } from './fetch.js';

// Where OpenAI requests go. Direct by default; once a Worker has both
// CLOUDFLARE_ACCOUNT_ID and AI_GATEWAY_ID in its vars, every call is routed
// through that AI Gateway instead (same request and response shapes, same
// OpenAI key) for per-request logs, cost tracking, retries and caching. The
// base URL is per isolate, set once from env at each entry point, because
// the call sites take an API key rather than the whole env.
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
let baseUrl = OPENAI_BASE_URL;

/** @param {{CLOUDFLARE_ACCOUNT_ID?: string, AI_GATEWAY_ID?: string} | undefined} env */
export function configureOpenAi(env) {
  const account = String(env?.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  const gateway = String(env?.AI_GATEWAY_ID ?? '').trim();
  baseUrl =
    account && gateway
      ? `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/openai`
      : OPENAI_BASE_URL;
  return baseUrl;
}

/**
 * The base every OpenAI-compatible caller should use — including Meilisearch's
 * chat workspace, which makes its own LLM calls and is pointed at the same
 * gateway so those calls get the same logs and cost tracking.
 */
export function openAiBaseUrl() {
  return baseUrl;
}

/** @param {string} path e.g. 'responses' or 'chat/completions' */
export function openAiUrl(path) {
  return `${baseUrl}/${path}`;
}

export function responsesUrl() {
  return openAiUrl('responses');
}

/**
 * Extracts the text payload from an OpenAI Responses API result, covering
 * both the top-level `output_text` convenience field and the underlying
 * `output[].content[]` structure it's derived from.
 *
 * @param {any} body
 * @returns {string}
 */
export function outputText(body) {
  if (typeof body?.output_text === 'string') return body.output_text;
  for (const item of body?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return '';
}

/** A Responses API result that cannot be consumed as complete JSON output. */
export class OpenAIOutputError extends Error {
  /** @param {string} message @param {{cause?: unknown}} [options] */
  constructor(message, options) {
    super(message, options);
    this.name = 'OpenAIOutputError';
  }
}

/**
 * Parses the JSON payload of a Responses API result, surfacing incomplete or
 * empty outputs as descriptive errors instead of opaque SyntaxErrors.
 *
 * @param {any} body
 * @returns {any}
 */
export function parseOutputJson(body) {
  if (body?.status === 'incomplete') {
    throw new OpenAIOutputError(
      `OpenAI response incomplete (${body?.incomplete_details?.reason || 'unknown'})`,
    );
  }
  const text = outputText(body);
  if (!text.trim()) throw new OpenAIOutputError('OpenAI response contained no output text');
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new OpenAIOutputError('OpenAI response contained invalid JSON', { cause });
  }
}

/** A non-2xx answer from the Responses API. */
export class ResponsesApiError extends Error {
  /**
   * @param {number} status
   * @param {string | null} [code] OpenAI's error code, e.g.
   *   `unsupported_country_region_territory` for a 403 from a blocked region
   */
  constructor(status, code = null) {
    super(`OpenAI Responses API responded ${status}${code ? ` (${code})` : ''}`);
    this.name = 'ResponsesApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * OpenAI's machine-readable error code, without any of the body's prose. A
 * body that is not JSON or has no usable code gives null.
 *
 * @param {Response} response
 */
export async function openAiErrorCode(response) {
  try {
    const body = /** @type {any} */ (await response.json());
    const code = body?.error?.code ?? body?.error?.type;
    return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {{
 *   model: string,
 *   input: unknown[],
 *   maxOutputTokens: number,
 *   reasoningEffort?: 'none' | 'low' | 'medium' | 'high',
 *   format?: {name: string, schema: object},
 *   store?: boolean,
 * }} ResponsesBodyOptions
 */

/**
 * The JSON body of one Responses API request. Reasoning tokens share the
 * output cap, so every caller names its cap, and a reasoning effort is sent
 * only to models that accept one. Leaving the effort out keeps the model's
 * default, which can spend a small cap before any answer is written.
 *
 * @param {ResponsesBodyOptions} options
 */
export function responsesBody({ model, input, maxOutputTokens, reasoningEffort, format, store }) {
  return {
    model,
    ...(store === undefined ? {} : { store }),
    max_output_tokens: maxOutputTokens,
    ...(reasoningEffort && supportsReasoning(model)
      ? { reasoning: { effort: reasoningEffort } }
      : {}),
    input,
    ...(format
      ? {
          text: {
            format: { type: 'json_schema', name: format.name, strict: true, schema: format.schema },
          },
        }
      : {}),
  };
}

/**
 * Sends one Responses API request and returns the response payload. A
 * non-2xx answer throws ResponsesApiError; the timeout covers the headers
 * and the body. The payload is returned as is: parseOutputJson then names an
 * incomplete or empty answer.
 *
 * @param {ResponsesBodyOptions & {apiKey: string, timeoutMs: number, fetchImpl?: typeof fetch}} options
 * @returns {Promise<any>}
 */
export async function requestResponses({ apiKey, timeoutMs, fetchImpl = fetch, ...body }) {
  return fetchWithTimeout(
    responsesUrl(),
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(responsesBody(body)),
    },
    async (response) => {
      if (!response.ok) {
        throw new ResponsesApiError(response.status, await openAiErrorCode(response));
      }
      return response.json();
    },
    timeoutMs,
    fetchImpl,
  );
}

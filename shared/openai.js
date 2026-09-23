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

import * as Sentry from '@sentry/cloudflare';
import { responsesUrl } from './openai.js';

// Raw fetch calls are not covered by the OpenAI SDK integration. Capture only
// model metadata and token totals; never prompts, documents, or response text.
/** @param {string} model @param {RequestInit} options */
export async function requestAiJson(model, options) {
  return Sentry.startSpan(
    {
      op: 'gen_ai.chat',
      name: `chat ${model}`,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': 'openai',
        'gen_ai.request.model': model,
      },
    },
    async (span) => {
      try {
        const response = await fetch(responsesUrl(), options);
        if (!response.ok) throw new Error(`OpenAI Responses API responded ${response.status}`);
        const payload = await response.json();
        if (typeof payload.model === 'string')
          span.setAttribute('gen_ai.response.model', payload.model);
        const usage = payload.usage;
        for (const [key, value] of Object.entries({
          input_tokens: usage?.input_tokens,
          output_tokens: usage?.output_tokens,
          'cache_read.input_tokens': usage?.input_tokens_details?.cached_tokens,
          'reasoning.output_tokens': usage?.output_tokens_details?.reasoning_tokens,
        })) {
          if (Number.isSafeInteger(value) && value >= 0)
            span.setAttribute(`gen_ai.usage.${key}`, value);
        }
        if (payload.status && payload.status !== 'completed') {
          span.setStatus({ code: 2 });
          span.setAttribute('error.type', 'incomplete_response');
        }
        return payload;
      } catch (error) {
        span.setStatus({ code: 2 });
        span.setAttribute('error.type', 'model_request_failed');
        throw error;
      }
    },
  );
}

const allowedAttributes = new Set([
  'sentry.op',
  'sentry.origin',
  'sentry.trace_lifecycle',
  'sentry.segment.id',
  'gen_ai.operation.name',
  'gen_ai.provider.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.conversation.id',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.reasoning.output_tokens',
  'error.type',
]);

// Enabling sampling also creates HTTP/database spans. Strip their names and
// attributes because SQL and URLs can include private data.
/** @param {import('@sentry/core').StreamedSpanJSON} span */
export function sanitizeAiSpan(span) {
  const isAi = span.attributes?.['sentry.op'] === 'gen_ai.chat';
  return {
    trace_id: span.trace_id,
    parent_span_id: span.parent_span_id,
    span_id: span.span_id,
    name: isAi ? span.name : 'worker',
    start_timestamp: span.start_timestamp,
    end_timestamp: span.end_timestamp,
    status: span.status,
    is_segment: span.is_segment,
    attributes: {
      ...Object.fromEntries(
        Object.entries(span.attributes ?? {}).filter(([key]) => isAi && allowedAttributes.has(key)),
      ),
      'sentry.op': isAi ? 'gen_ai.chat' : 'worker',
      'sentry.trace_lifecycle': 'stream',
      'service.name': 'cookie-web-ai',
    },
  };
}

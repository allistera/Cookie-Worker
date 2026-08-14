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

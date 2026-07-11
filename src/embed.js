export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_INPUT_CAP = 24000;
export const EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

/**
 * @param {import('postgres').Sql} sql
 * @param {{messageId: string, subject?: string | null, bodyText?: string | null}} record
 * @param {string} messageUuid
 * @param {string} apiKey
 */
export async function embedMessage(sql, record, messageUuid, apiKey) {
  const input = buildEmbeddingInput(record.subject, record.bodyText);
  const response = await fetch(EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      input,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI embeddings API responded ${response.status}`);
  }
  const body = await response.json();
  const vector = body?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `OpenAI embeddings API returned invalid vector (expected ${EMBEDDING_DIMENSIONS} dimensions)`,
    );
  }

  await sql`
    UPDATE messages
    SET embedding = ${JSON.stringify(vector)}::vector,
        embedding_model = ${EMBEDDING_MODEL}
    WHERE id = ${messageUuid}
      AND embedding IS NULL
  `;
  console.log(JSON.stringify({ event: 'embedded', message_id: record.messageId }));
}

/**
 * @param {string | null | undefined} subject
 * @param {string | null | undefined} bodyText
 */
export function buildEmbeddingInput(subject, bodyText) {
  const input = `${subject ?? ''}\n\n${bodyText ?? ''}`.slice(0, EMBEDDING_INPUT_CAP);
  return input.trim() ? input : ' ';
}

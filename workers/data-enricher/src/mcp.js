import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';

export function createMcpClient() {
  return new Client(
    { name: 'data-enricher', version: '1.0.0' },
    {
      // The default ajv validator compiles schemas with new Function(), which
      // the Workers runtime forbids; this validator interprets schemas instead.
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );
}

/**
 * Connect to a remote MCP server over streamable HTTP.
 *
 * @param {string} url
 * @param {{bearerToken?: string}} [options]
 */
export async function connectMcp(url, { bearerToken } = {}) {
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    bearerToken
      ? { requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } } }
      : undefined,
  );
  const client = createMcpClient();
  const timeoutMs = 15_000;
  let timer;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('MCP connect timed out')), timeoutMs);
      }),
    ]);
  } catch (error) {
    // A timed-out connect throws before the caller ever receives the client,
    // so its `finally { client.close() }` never runs — close the half-open
    // client/transport here or the socket leaks in the isolate until eviction.
    await client.close().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return client;
}

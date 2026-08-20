import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';

export function createMcpClient() {
  return new Client({ name: 'data-enricher', version: '1.0.0' }, {
    // The default ajv validator compiles schemas with new Function(), which
    // the Workers runtime forbids; this validator interprets schemas instead.
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  });
}

/**
 * Connect to a remote MCP server over streamable HTTP.
 *
 * @param {string} url
 * @param {{bearerToken?: string}} [options]
 */
export async function connectMcp(url, { bearerToken } = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(url), bearerToken
    ? { requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } } }
    : undefined);
  const client = createMcpClient();
  const timeoutMs = 15_000;
  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('MCP connect timed out')), timeoutMs);
    }),
  ]);
  return client;
}

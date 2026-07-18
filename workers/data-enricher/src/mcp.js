import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';

/**
 * Connect to one MCP server over the given transport and inventory its tools.
 * Placeholder gather step until the real result collection lands.
 *
 * @param {import('@modelcontextprotocol/sdk/shared/transport.js').Transport} transport
 */
export async function gather(transport) {
  const client = new Client({ name: 'data-enricher', version: '1.0.0' }, {
    // The default ajv validator compiles schemas with new Function(), which
    // the Workers runtime forbids; this validator interprets schemas instead.
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return { tools: tools.map((tool) => tool.name) };
  } finally {
    await client.close();
  }
}

import { describe, expect, test } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { gather } from '../src/mcp.js';

function stubServer(name, toolNames) {
  const server = new McpServer({ name, version: '1.0.0' });
  for (const toolName of toolNames) {
    server.registerTool(toolName, { description: `${toolName} stub` }, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
  }
  return server;
}

describe('gather', () => {
  test('connects to an MCP server and inventories its tools', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await stubServer('reports', ['fetch-report', 'fetch-summary']).connect(serverTransport);

    await expect(gather(clientTransport)).resolves.toEqual({
      tools: ['fetch-report', 'fetch-summary'],
    });
  });

  test('closes the connection even when listing fails', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // A bare transport with no server behind it: initialization cannot complete.
    await serverTransport.close();

    await expect(gather(clientTransport)).rejects.toThrow();
    // The client transport must have been shut down by gather's cleanup.
    await expect(clientTransport.send({ jsonrpc: '2.0', method: 'ping', id: 1 }))
      .rejects.toThrow('Not connected');
  });
});

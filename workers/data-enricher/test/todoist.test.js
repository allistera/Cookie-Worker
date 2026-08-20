import { describe, expect, test } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpClient } from '../src/mcp.js';
import { gatherTodoistTasks } from '../src/todoist.js';

const TODAY_TASKS = {
  tasks: [
    {
      id: '6gxqg2WQ',
      content: 'File VAT return',
      description: 'Q2 receipts',
      dueDate: '2026-07-18',
      recurring: false,
      priority: 'p1',
      projectId: 'proj-1',
      labels: [],
      checked: false,
    },
    {
      id: '6h6JMmgf',
      content: 'Already done',
      description: '',
      dueDate: '2026-07-18',
      recurring: false,
      priority: 'p4',
      projectId: 'proj-1',
      labels: [],
      checked: true,
    },
    {
      id: '6h6JMpVx',
      content: 'Chase invoice',
      description: '',
      dueDate: '2026-07-17',
      recurring: false,
      priority: 'p4',
      projectId: 'proj-1',
      labels: [],
      checked: false,
    },
  ],
  totalCount: 3,
  hasMore: false,
};

async function connectedClient(handler) {
  const server = new Server(
    { name: 'todoist-stub', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'find-tasks-by-date', description: 'stub', inputSchema: { type: 'object' } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handler(request.params.arguments),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = createMcpClient();
  await client.connect(clientTransport);
  return client;
}

describe('gatherTodoistTasks', () => {
  test('maps uncompleted tasks due today into task records', async () => {
    let seenArgs;
    const client = await connectedClient(async (args) => {
      seenArgs = args;
      return { content: [{ type: 'text', text: JSON.stringify(TODAY_TASKS) }] };
    });

    const tasks = await gatherTodoistTasks(client);
    expect(seenArgs).toEqual({ startDate: 'today' });
    expect(tasks).toEqual([
      {
        source: 'todoist',
        externalId: '6gxqg2WQ',
        content: 'File VAT return',
        description: 'Q2 receipts',
        dueDate: '2026-07-18',
        priority: 4,
        url: 'https://app.todoist.com/app/task/6gxqg2WQ',
        raw: TODAY_TASKS.tasks[0],
      },
      {
        source: 'todoist',
        externalId: '6h6JMpVx',
        content: 'Chase invoice',
        description: null,
        dueDate: '2026-07-17',
        priority: 1,
        url: 'https://app.todoist.com/app/task/6h6JMpVx',
        raw: TODAY_TASKS.tasks[2],
      },
    ]);
  });

  test('throws when the tool reports an error', async () => {
    const client = await connectedClient(async () => ({
      isError: true,
      content: [{ type: 'text', text: 'rate limited' }],
    }));
    await expect(gatherTodoistTasks(client)).rejects.toThrow(
      'find-tasks-by-date failed: rate limited',
    );
  });
});

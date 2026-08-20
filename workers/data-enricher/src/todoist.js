// Todoist MCP priorities are p1 (urgent) through p4 (default); the tasks
// table stores the Todoist API numeric convention where 4 is urgent.
const PRIORITY_BY_NAME = { p1: 4, p2: 3, p3: 2, p4: 1 };

/** @param {any} result */
function textContent(result) {
  return (
    result.content?.find((/** @type {{type: string}} */ item) => item.type === 'text')?.text ?? ''
  );
}

/**
 * Gather uncompleted Todoist tasks due today, including overdue ones, via the
 * official Todoist MCP server's find-tasks-by-date tool.
 *
 * @param {import('@modelcontextprotocol/sdk/client/index.js').Client} client
 * @returns {Promise<import('./store.js').TaskRecord[]>}
 */
export async function gatherTodoistTasks(client) {
  const result = await client.callTool({
    name: 'find-tasks-by-date',
    arguments: { startDate: 'today' },
  });
  if (result.isError) {
    throw new Error(`find-tasks-by-date failed: ${textContent(result)}`);
  }
  const payload = result.structuredContent ?? JSON.parse(textContent(result) || '{}');
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  return tasks
    .filter((task) => !task.checked)
    .map((task) => ({
      source: /** @type {'todoist'} */ ('todoist'),
      externalId: String(task.id),
      content: task.content,
      description: task.description || null,
      dueDate: task.dueDate ?? null,
      priority: PRIORITY_BY_NAME[task.priority] ?? null,
      url: `https://app.todoist.com/app/task/${task.id}`,
      raw: task,
    }));
}

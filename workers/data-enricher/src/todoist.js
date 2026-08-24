// Todoist MCP priorities are p1 (urgent) through p4 (default); the tasks
// table stores the Todoist API numeric convention where 4 is urgent.
const PRIORITY_BY_NAME = { p1: 4, p2: 3, p3: 2, p4: 1 };

// The MCP server is authenticated but still an external service — a
// successful tool result is not trusted application data. Every field is
// validated against these budgets before anything is mapped or persisted;
// tasks that fail structural checks (bad id, no content) are dropped rather
// than failing the whole gather.
const MAX_TASKS = 200;
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CONTENT_CHARS = 2000;
const MAX_DESCRIPTION_CHARS = 8000;
const MAX_RAW_BYTES = 16 * 1024;

/**
 * A YYYY-MM-DD date string that survives the store layer's `::date` cast, or
 * null — an unparsable value from the server must not abort the whole batch
 * insert.
 *
 * @param {unknown} value
 */
function validDueDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const day = value.slice(0, 10);
  return Number.isNaN(Date.parse(day)) ? null : day;
}

/** @param {any} task @param {string} id */
function boundedRaw(task, id) {
  try {
    if (JSON.stringify(task).length <= MAX_RAW_BYTES) return task;
  } catch {
    // fall through — circular or otherwise unserializable
  }
  return { id, truncated: true };
}

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
  // structuredContent is the normal path; a server that only returns text
  // gets one guarded parse so a malformed payload fails with a clear error
  // instead of a bare SyntaxError from deep inside the gather phase.
  /** @type {any} */
  let payload = result.structuredContent;
  if (!payload) {
    try {
      payload = JSON.parse(textContent(result) || '{}');
    } catch {
      throw new Error('Todoist MCP returned a non-JSON text payload');
    }
  }
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  return tasks
    .filter((task) => task && typeof task === 'object' && !task.checked)
    .slice(0, MAX_TASKS)
    .flatMap((task) => {
      // The id is interpolated into a URL and used as the upsert key, so it
      // must be a bounded, URL-safe token — not an arbitrary server string.
      const id = String(task.id ?? '');
      if (!TASK_ID_RE.test(id)) return [];
      const content =
        typeof task.content === 'string' ? task.content.slice(0, MAX_CONTENT_CHARS).trim() : '';
      if (!content) return [];
      const description =
        typeof task.description === 'string' && task.description
          ? task.description.slice(0, MAX_DESCRIPTION_CHARS)
          : null;
      return [
        {
          source: /** @type {'todoist'} */ ('todoist'),
          externalId: id,
          content,
          description,
          dueDate: validDueDate(task.dueDate),
          priority: PRIORITY_BY_NAME[task.priority] ?? null,
          url: `https://app.todoist.com/app/task/${id}`,
          raw: boundedRaw(task, id),
        },
      ];
    });
}

import postgres from 'postgres';
import { connectMcp } from './mcp.js';
import { gatherTodoistTasks } from './todoist.js';
import { analyzeEmail, fetchImportantMessages } from './analyze.js';
import { lookupUserId, storeSummary, storeTasks } from './store.js';

/** @param {string} databaseUrl */
export function createSql(databaseUrl) {
  // No ssl option: Hyperdrive terminates TLS to the origin database itself;
  // asking the driver for TLS makes every connect fail (see mail-app-ingest).
  return postgres(databaseUrl, {
    prepare: false,
    max: 1,
  });
}

/** @param {string} content */
function fingerprint(content) {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * @param {import('postgres').Sql} sql
 * @param {Env & {TODOIST_API_TOKEN?: string, OPENAI_API_KEY?: string}} env
 * @param {string} userId
 */
async function gatherTodoist(sql, env, userId) {
  const client = await connectMcp(env.TODOIST_MCP_URL, { bearerToken: env.TODOIST_API_TOKEN });
  /** @type {import('./store.js').TaskRecord[]} */
  let tasks;
  try {
    tasks = await gatherTodoistTasks(client);
  } finally {
    await client.close();
  }
  await storeTasks(sql, userId, tasks);
  console.log(JSON.stringify({ event: 'todoist_gathered', count: tasks.length }));
}

/**
 * @param {import('postgres').Sql} sql
 * @param {Env & {TODOIST_API_TOKEN?: string, OPENAI_API_KEY?: string}} env
 * @param {string} userId
 */
async function analyzeImportantEmails(sql, env, userId) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const messages = await fetchImportantMessages(sql, userId);
  let extracted = 0;
  for (const message of messages) {
    const analysis = await analyzeEmail(message, apiKey, env.AI_MODEL);
    await storeSummary(sql, userId, {
      messageId: message.id,
      summary: analysis.summary,
      model: env.AI_MODEL,
      raw: { ...analysis, prompt_version: 'email-task-analysis-v1' },
    });
    const tasks = analysis.tasks.map((task) => ({
      source: /** @type {'email'} */ ('email'),
      externalId: `${message.id}:${fingerprint(task.content)}`,
      content: task.content,
      dueDate: task.due_date ?? null,
      messageId: message.id,
      raw: task,
    }));
    await storeTasks(sql, userId, tasks);
    extracted += tasks.length;
  }
  console.log(JSON.stringify({ event: 'emails_analyzed', messages: messages.length, tasks: extracted }));
}

export default {
  /**
   * @param {ScheduledController} _controller
   * @param {Env & {TODOIST_API_TOKEN?: string, OPENAI_API_KEY?: string}} env
   * @param {ExecutionContext} _ctx
   */
  async scheduled(_controller, env, _ctx) {
    const sql = createSql(env.HYPERDRIVE.connectionString);
    /** @type {Error[]} */
    const failures = [];
    try {
      const userId = await lookupUserId(sql, env.OWNER_EMAIL);
      // The two phases are independent; one failing must not starve the other.
      for (const phase of [gatherTodoist, analyzeImportantEmails]) {
        try {
          await phase(sql, env, userId);
        } catch (error) {
          failures.push(/** @type {Error} */ (error));
          console.log(JSON.stringify({ event: 'phase_failed', phase: phase.name, error: String(error) }));
        }
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'data-enricher run had failures');
    }
  },
};

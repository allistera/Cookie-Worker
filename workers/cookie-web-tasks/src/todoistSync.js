// One-way Todoist sync for the Tasks app. Todoist is the source of truth:
// every run reads the account's projects, sections and open tasks and makes
// task_projects / task_items match, keyed by todoist_id (migration 0093).
//
// What maps to what:
// - A project becomes a task_projects row under its Todoist parent. The
//   Todoist Inbox is Cookie's Inbox (project_id NULL), so it gets no row.
// - A section becomes a divider (kind = 'divider', migration 0064) headed
//   with its name, keyed `section:<id>`; the tasks in it follow it in order.
// - A task becomes a task_items row with Todoist's priority inverted (4 is
//   urgent there, 1 here), labels normalised the way Cookie writes them, the
//   due date and time (in the task's own zone, or the account's), and the
//   repeat rule when Cookie understands its wording.
// - Sub-tasks keep their parent; a parent Cookie cannot see makes the task
//   top-level rather than losing it.
//
// Between runs: a mirrored task Todoist no longer lists as open is marked
// completed when it appears in the recently-completed list, and deleted
// otherwise. A mirrored project that vanished is deleted when it holds only
// mirrors and unlinked (kept, as an ordinary project) when a Cookie-authored
// task or sub-project lives in it. Rows with a null todoist_id are never
// touched, so Cookie's own tasks sit alongside the mirrors in the same lists.
//
// Reads happen first, outside any transaction; the database work then runs
// under the same per-owner advisory lock the task writes take, so a sync
// never interleaves with a drag or a completion. Rows are upserted a tree
// level at a time through jsonb_to_recordset, so a few hundred tasks cost a
// handful of statements rather than one each.

import { TASKS_INDEX } from '../../../shared/meili/tasks.js';
import { addDocuments, deleteDocuments, meiliAvailable } from '../../../shared/meili.js';
import { MEILI_CHUNK_SIZE } from '../../../shared/meiliSync.js';
import { isCalendarDate, registerTaskLabels } from './taskItems.js';
import { isTaskTimeZone, normalizeTaskLabels } from './taskMetadata.js';
import { parseTaskRecurrence } from './taskRecurrence.js';
import { TodoistApiError, TodoistAuthError, fetchSnapshot } from './todoistApi.js';

export const DEFAULT_TIME_ZONE = 'Europe/London';
// The hourly cron runs the sync at these local hours, inclusive.
export const SYNC_START_HOUR = 7;
export const SYNC_END_HOUR = 20;
export const SECTION_PREFIX = 'section:';
// How far back the first run (or one after a long gap) looks for completions
// of tasks it still holds open.
export const COMPLETED_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
// Overlap between runs so a completion stamped just before the previous run
// finished is not missed.
const COMPLETED_OVERLAP_MS = 60 * 60 * 1000;
const MAX_CONTENT_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 10000;
const MAX_DIVIDER_TEXT_LENGTH = 120;
const MAX_PROJECT_NAME_LENGTH = 120;
const MAX_LABELS = 20;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_SYNC_ERROR_LENGTH = 500;

/** @typedef {{HYPERDRIVE: {connectionString: string}, TODOIST_TOKEN_ENCRYPTION_KEY?: string, MEILISEARCH_URL?: string, MEILISEARCH_API_KEY?: string, deferSearchSync?: Function}} TodoistSyncEnv */

/**
 * @typedef {{
 *   projects: number, sections: number, tasks: number, completed: number,
 *   removed: number, skipped: number,
 * }} SyncSummary
 */

// ---------------------------------------------------------------------------
// Field mapping

/** @param {any} value @param {number} max */
function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, max);
  return text || null;
}

/**
 * Todoist counts up to urgent (4); Cookie counts down to it (1).
 *
 * @param {unknown} value
 */
export function mapPriority(value) {
  const priority = Number.isInteger(value) ? /** @type {number} */ (value) : 1;
  return 5 - Math.min(4, Math.max(1, priority));
}

/**
 * Todoist label names as Cookie label names: lowercased, spaces become
 * underscores, @ and # dropped, anything still invalid left out. At most
 * twenty, like a task written in Cookie.
 *
 * @param {unknown} labels
 * @returns {string[]}
 */
export function mapLabels(labels) {
  if (!Array.isArray(labels)) return [];
  /** @type {string[]} */
  const names = [];
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    const candidate = label.trim().replaceAll(/[@#]/g, '').replaceAll(/\s+/g, '_').slice(0, 40);
    try {
      const [name] = normalizeTaskLabels([candidate]);
      if (name && !names.includes(name)) names.push(name);
    } catch {
      // Not a name Cookie can hold; the task keeps its other labels.
    }
    if (names.length === MAX_LABELS) break;
  }
  return names;
}

/** @type {Map<string, Intl.DateTimeFormat>} */
const zoneFormats = new Map();

/** @param {string} timeZone */
function zoneFormat(timeZone) {
  let format = zoneFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    zoneFormats.set(timeZone, format);
  }
  return format;
}

/**
 * A Todoist due object as Cookie's date-only due date, optional time in a
 * zone, and repeat rule. Todoist writes `date` as `YYYY-MM-DD`, a floating
 * `YYYY-MM-DDTHH:MM:SS`, or an instant ending in `Z` when the task has a
 * fixed zone (which `timezone` then names); older shapes carry the time in
 * `datetime` instead. An instant is shown in the task's zone, or the
 * account's when Todoist gives none, so the date is the day the person
 * meant rather than the UTC day. A repeat Cookie cannot phrase stays a plain
 * dated task — Todoist keeps advancing it, and each run picks up the new
 * date.
 *
 * @param {any} due
 * @param {string} fallbackZone
 * @returns {{dueDate: string | null, dueTime: string | null, timeZone: string | null, recurrence: string | null}}
 */
export function mapDue(due, fallbackZone) {
  const none = { dueDate: null, dueTime: null, timeZone: null, recurrence: null };
  if (!due || typeof due !== 'object') return none;
  const raw =
    typeof due.datetime === 'string' && due.datetime
      ? due.datetime
      : typeof due.date === 'string'
        ? due.date
        : '';
  if (!raw) return none;
  const zone = isTaskTimeZone(due.timezone) ? String(due.timezone) : fallbackZone;
  let dueDate = raw.slice(0, 10);
  /** @type {string | null} */
  let dueTime = null;
  if (raw.length > 10 && raw[10] === 'T') {
    if (/(?:Z|[+-]\d\d:?\d\d)$/i.test(raw)) {
      const instant = new Date(raw);
      if (Number.isNaN(instant.getTime())) return none;
      const parts = Object.fromEntries(
        zoneFormat(zone)
          .formatToParts(instant)
          .filter(({ type }) => type !== 'literal')
          .map(({ type, value }) => [type, value]),
      );
      dueDate = `${parts.year}-${parts.month}-${parts.day}`;
      dueTime = `${parts.hour}:${parts.minute}`;
    } else {
      dueTime = raw.slice(11, 16);
    }
  }
  if (!isCalendarDate(dueDate)) return none;
  if (dueTime !== null && !TIME_RE.test(dueTime)) dueTime = null;
  const rule = due.is_recurring === true ? parseTaskRecurrence(due.string) : null;
  return {
    dueDate,
    dueTime,
    timeZone: dueTime === null ? null : zone,
    recurrence: rule?.text ?? null,
  };
}

/** @param {any} value */
function orderOf(value) {
  return Number.isFinite(value) ? Number(value) : Number.MAX_SAFE_INTEGER;
}

/** @param {any} project */
function isInboxProject(project) {
  return project?.inbox_project === true || project?.is_inbox_project === true;
}

// ---------------------------------------------------------------------------
// Planning (pure)

/**
 * @typedef {{todoistId: string, name: string, parentTodoistId: string | null, description: string | null, depth: number}} PlannedProject
 * @typedef {{todoistId: string, content: string, projectTodoistId: string | null, position: number}} PlannedSection
 * @typedef {{
 *   todoistId: string, content: string, description: string | null,
 *   projectTodoistId: string | null, parentTodoistId: string | null,
 *   dueDate: string | null, dueTime: string | null, timeZone: string | null,
 *   recurrence: string | null, labels: string[], priority: number,
 *   position: number, depth: number,
 * }} PlannedTask
 * @typedef {{
 *   projects: PlannedProject[], sections: PlannedSection[], tasks: PlannedTask[],
 *   completed: Map<string, string>, labels: string[], skipped: number,
 * }} SyncPlan
 */

/**
 * Turns a Todoist snapshot into the rows Cookie will hold, with nothing
 * resolved to database ids yet. Archived and deleted projects and sections
 * are left out, and so are tasks in a project the plan does not know
 * (counted as skipped) — dropping them into the Inbox would mislabel them.
 *
 * Within a project the order is: tasks in no section, then each section's
 * divider followed by its tasks, sections and tasks each in Todoist's own
 * order. Positions count up from one per project, so Cookie-authored rows
 * (positioned at epoch seconds, migration 0062) always follow the mirrors.
 * A sub-task's position is its order among its siblings.
 *
 * @param {{projects: any[], sections: any[], tasks: any[], completed: any[]}} snapshot
 * @param {{timeZone: string}} options
 * @returns {SyncPlan}
 */
export function planSync(snapshot, { timeZone }) {
  const fallbackZone = isTaskTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  /** @type {Set<string>} */
  const inboxIds = new Set();
  /** @type {Map<string, any>} */
  const liveProjects = new Map();
  for (const project of snapshot.projects ?? []) {
    if (typeof project?.id !== 'string' || !project.id) continue;
    if (project.is_deleted === true || project.is_archived === true) continue;
    if (isInboxProject(project)) {
      inboxIds.add(project.id);
      continue;
    }
    liveProjects.set(project.id, project);
  }

  /** @param {string} id */
  const projectKey = (id) => (inboxIds.has(id) ? null : liveProjects.has(id) ? id : undefined);

  /** @type {Map<string, number>} */
  const projectDepth = new Map();
  /** @param {string} id */
  const depthOf = (id) => {
    const known = projectDepth.get(id);
    if (known !== undefined) return known;
    projectDepth.set(id, 0); // guards against a cycle in bad data
    const parent = liveProjects.get(id)?.parent_id;
    const depth =
      typeof parent === 'string' && liveProjects.has(parent) && parent !== id
        ? depthOf(parent) + 1
        : 0;
    projectDepth.set(id, depth);
    return depth;
  };
  /** @type {PlannedProject[]} */
  const projects = [...liveProjects.values()]
    .map((project) => ({
      todoistId: String(project.id),
      name: cleanText(project.name, MAX_PROJECT_NAME_LENGTH) ?? 'Untitled project',
      parentTodoistId:
        typeof project.parent_id === 'string' && liveProjects.has(project.parent_id)
          ? project.parent_id
          : null,
      description: cleanText(project.description, MAX_DESCRIPTION_LENGTH),
      depth: depthOf(project.id),
    }))
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        orderOf(liveProjects.get(a.todoistId)?.child_order) -
          orderOf(liveProjects.get(b.todoistId)?.child_order),
    );

  // Sections and tasks grouped by the project key they land in: null for
  // the Inbox, the Todoist project id otherwise.
  /** @type {Map<string | null, any[]>} */
  const sectionsByProject = new Map();
  /** @type {Map<string, any>} */
  const liveSections = new Map();
  for (const section of snapshot.sections ?? []) {
    if (typeof section?.id !== 'string' || !section.id) continue;
    if (section.is_deleted === true || section.is_archived === true) continue;
    const key = projectKey(String(section.project_id ?? ''));
    if (key === undefined) continue;
    liveSections.set(section.id, section);
    const list = sectionsByProject.get(key) ?? [];
    list.push(section);
    sectionsByProject.set(key, list);
  }

  let skipped = 0;
  /** @type {Map<string, any>} */
  const liveTasks = new Map();
  for (const task of snapshot.tasks ?? []) {
    if (typeof task?.id !== 'string' || !task.id) continue;
    if (task.is_deleted === true || task.checked === true) continue;
    if (projectKey(String(task.project_id ?? '')) === undefined) {
      skipped += 1;
      continue;
    }
    liveTasks.set(task.id, task);
  }

  /** @type {Map<string, number>} */
  const taskDepth = new Map();
  /** @param {string} id */
  const taskDepthOf = (id) => {
    const known = taskDepth.get(id);
    if (known !== undefined) return known;
    taskDepth.set(id, 0);
    const parent = liveTasks.get(id)?.parent_id;
    const depth =
      typeof parent === 'string' && liveTasks.has(parent) && parent !== id
        ? taskDepthOf(parent) + 1
        : 0;
    taskDepth.set(id, depth);
    return depth;
  };

  /** @type {PlannedSection[]} */
  const sections = [];
  /** @type {PlannedTask[]} */
  const tasks = [];
  /** @type {Set<string>} */
  const labels = new Set();

  // Top-level tasks take their place in the project's running order; a
  // sub-task is placed among its siblings. Both go through the same mapper.
  /** @param {any} task @param {number} position */
  const planTask = (task, position) => {
    const parentId =
      typeof task.parent_id === 'string' && liveTasks.has(task.parent_id) ? task.parent_id : null;
    const due = mapDue(task.due, fallbackZone);
    const taskLabels = mapLabels(task.labels);
    for (const name of taskLabels) labels.add(name);
    tasks.push({
      todoistId: String(task.id),
      content: cleanText(task.content, MAX_CONTENT_LENGTH) ?? 'Untitled task',
      description: cleanText(task.description, MAX_DESCRIPTION_LENGTH),
      projectTodoistId: /** @type {string | null} */ (projectKey(String(task.project_id))),
      parentTodoistId: parentId,
      ...due,
      labels: taskLabels,
      priority: mapPriority(task.priority),
      position,
      depth: taskDepthOf(task.id),
    });
  };

  /** @type {Map<string | null, any[]>} */
  const rootsByProject = new Map();
  for (const task of liveTasks.values()) {
    const parentId = task.parent_id;
    if (typeof parentId === 'string' && liveTasks.has(parentId)) {
      planTask(task, orderOf(task.child_order));
      continue;
    }
    const key = /** @type {string | null} */ (projectKey(String(task.project_id)));
    const list = rootsByProject.get(key) ?? [];
    list.push(task);
    rootsByProject.set(key, list);
  }

  // Inbox first, then projects in their own order, so positions and the
  // divider list come out the same for the same account every run.
  const projectKeys = [null, ...projects.map((project) => project.todoistId)].filter(
    (key) => rootsByProject.has(key) || sectionsByProject.has(key),
  );
  for (const key of projectKeys) {
    const roots = (rootsByProject.get(key) ?? []).sort(
      (a, b) => orderOf(a.child_order) - orderOf(b.child_order),
    );
    const projectSections = (sectionsByProject.get(key) ?? []).sort(
      (a, b) => orderOf(a.section_order) - orderOf(b.section_order),
    );
    let position = 0;
    const unsectioned = roots.filter(
      (task) => typeof task.section_id !== 'string' || !liveSections.has(task.section_id),
    );
    for (const task of unsectioned) planTask(task, ++position);
    for (const section of projectSections) {
      sections.push({
        todoistId: `${SECTION_PREFIX}${section.id}`,
        content: cleanText(section.name, MAX_DIVIDER_TEXT_LENGTH) ?? '',
        projectTodoistId: key,
        position: ++position,
      });
      for (const task of roots.filter((row) => row.section_id === section.id)) {
        planTask(task, ++position);
      }
    }
  }
  tasks.sort((a, b) => a.depth - b.depth);

  /** @type {Map<string, string>} */
  const completed = new Map();
  for (const task of snapshot.completed ?? []) {
    if (typeof task?.id !== 'string' || typeof task.completed_at !== 'string') continue;
    if (Number.isNaN(Date.parse(task.completed_at))) continue;
    completed.set(task.id, new Date(task.completed_at).toISOString());
  }

  return { projects, sections, tasks, completed, labels: [...labels].sort(), skipped };
}

// ---------------------------------------------------------------------------
// Applying a plan

/** @param {unknown[]} rows */
function levels(rows) {
  /** @type {Map<number, any[]>} */
  const byDepth = new Map();
  for (const row of /** @type {any[]} */ (rows)) {
    const list = byDepth.get(row.depth) ?? [];
    list.push(row);
    byDepth.set(row.depth, list);
  }
  return [...byDepth.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
}

/**
 * Writes a plan into the caller's tables. Runs inside the caller's
 * transaction (and advisory lock); see syncConnection.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {SyncPlan} plan
 * @returns {Promise<{summary: SyncSummary, deletedRootIds: string[]}>}
 */
export async function applySync(sql, userId, plan) {
  /** @type {Map<string, string>} Todoist project id → Cookie project id */
  const projectIds = new Map();
  for (const level of levels(plan.projects)) {
    const rows = level.map((project) => ({
      todoist_id: project.todoistId,
      name: project.name,
      parent_id: project.parentTodoistId ? (projectIds.get(project.parentTodoistId) ?? null) : null,
      description: project.description,
    }));
    const saved = await sql`
      INSERT INTO task_projects (user_id, todoist_id, name, parent_id, description)
      SELECT ${userId}, r.todoist_id, r.name, r.parent_id::uuid, r.description
      FROM jsonb_to_recordset(${sql.json(rows)})
        AS r(todoist_id text, name text, parent_id text, description text)
      ON CONFLICT (user_id, todoist_id) WHERE todoist_id IS NOT NULL DO UPDATE SET
        name        = EXCLUDED.name,
        parent_id   = EXCLUDED.parent_id,
        -- A description written in Cookie survives a project that has none
        -- in Todoist.
        description = COALESCE(EXCLUDED.description, task_projects.description)
      RETURNING id, todoist_id AS "todoistId"
    `;
    for (const row of saved) projectIds.set(String(row.todoistId), String(row.id));
  }

  const keptProjects = plan.projects.map((project) => project.todoistId);
  // A vanished mirror goes when only mirrors depend on it; otherwise it
  // stays as an ordinary project so nothing written in Cookie is lost.
  const removedProjects = await sql`
    DELETE FROM task_projects p
    WHERE p.user_id = ${userId} AND p.todoist_id IS NOT NULL
      AND NOT (p.todoist_id = ANY(${keptProjects}::text[]))
      AND NOT EXISTS (SELECT 1 FROM task_items t
                      WHERE t.user_id = p.user_id AND t.project_id = p.id AND t.todoist_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM task_projects c
                      WHERE c.user_id = p.user_id AND c.parent_id = p.id AND c.todoist_id IS NULL)
    RETURNING p.id
  `;
  const unlinkedProjects = await sql`
    UPDATE task_projects SET todoist_id = NULL
    WHERE user_id = ${userId} AND todoist_id IS NOT NULL
      AND NOT (todoist_id = ANY(${keptProjects}::text[]))
    RETURNING id
  `;

  /** @param {string | null} todoistProjectId */
  const cookieProjectId = (todoistProjectId) =>
    todoistProjectId === null ? null : (projectIds.get(todoistProjectId) ?? null);

  const existing = await sql`
    SELECT id, todoist_id AS "todoistId", parent_id AS "parentId", completed_at AS "completedAt"
    FROM task_items
    WHERE user_id = ${userId} AND todoist_id IS NOT NULL
  `;

  if (plan.sections.length) {
    await sql`
      INSERT INTO task_items (user_id, todoist_id, kind, content, project_id, position)
      SELECT ${userId}, r.todoist_id, 'divider', r.content, r.project_id::uuid, r.position
      FROM jsonb_to_recordset(${sql.json(
        plan.sections.map((section) => ({
          todoist_id: section.todoistId,
          content: section.content,
          project_id: cookieProjectId(section.projectTodoistId),
          position: section.position,
        })),
      )}) AS r(todoist_id text, content text, project_id text, position float8)
      ON CONFLICT (user_id, todoist_id) WHERE todoist_id IS NOT NULL DO UPDATE SET
        content    = EXCLUDED.content,
        project_id = EXCLUDED.project_id,
        position   = EXCLUDED.position,
        updated_at = now()
    `;
  }

  /** @type {Map<string, string>} Todoist task id → Cookie task id */
  const taskIds = new Map();
  for (const level of levels(plan.tasks)) {
    const rows = level.map((task) => ({
      todoist_id: task.todoistId,
      content: task.content,
      description: task.description,
      project_id: cookieProjectId(task.projectTodoistId),
      parent_id: task.parentTodoistId ? (taskIds.get(task.parentTodoistId) ?? null) : null,
      due_date: task.dueDate,
      due_time: task.dueTime,
      time_zone: task.timeZone,
      labels: task.labels,
      priority: task.priority,
      recurrence: task.recurrence,
      position: task.position,
    }));
    const saved = await sql`
      INSERT INTO task_items (user_id, todoist_id, kind, content, description, project_id, parent_id,
                              due_date, due_time, time_zone, labels, priority, recurrence, position)
      SELECT ${userId}, r.todoist_id, 'task', r.content, r.description, r.project_id::uuid,
             r.parent_id::uuid, r.due_date::date, r.due_time::time, r.time_zone,
             COALESCE(r.labels, '{}'::text[]), r.priority::smallint, r.recurrence, r.position
      FROM jsonb_to_recordset(${sql.json(rows)})
        AS r(todoist_id text, content text, description text, project_id text, parent_id text,
             due_date text, due_time text, time_zone text, labels text[], priority int,
             recurrence text, position float8)
      ON CONFLICT (user_id, todoist_id) WHERE todoist_id IS NOT NULL DO UPDATE SET
        content      = EXCLUDED.content,
        description  = EXCLUDED.description,
        project_id   = EXCLUDED.project_id,
        parent_id    = EXCLUDED.parent_id,
        due_date     = EXCLUDED.due_date,
        due_time     = EXCLUDED.due_time,
        time_zone    = EXCLUDED.time_zone,
        labels       = EXCLUDED.labels,
        priority     = EXCLUDED.priority,
        recurrence   = EXCLUDED.recurrence,
        position     = EXCLUDED.position,
        -- A Today rank belongs to the day it was arranged on (taskItems.js).
        today_position = CASE WHEN task_items.due_date IS DISTINCT FROM EXCLUDED.due_date
                              THEN NULL ELSE task_items.today_position END,
        -- Todoist lists it as open, so it is open here too.
        completed_at = NULL,
        search_indexed_at = NULL,
        updated_at   = now()
      RETURNING id, todoist_id AS "todoistId", parent_id AS "parentId"
    `;
    for (const row of saved) taskIds.set(String(row.todoistId), String(row.id));
    // A changed sub-task changes its parent's search document, which only
    // carries sub-task titles; mark the parent for the re-index below.
    const parentIds = [...new Set(saved.map((row) => row.parentId).filter(Boolean))];
    if (parentIds.length) {
      await sql`
        UPDATE task_items SET search_indexed_at = NULL
        WHERE user_id = ${userId} AND id = ANY(${parentIds}::uuid[])
      `;
    }
  }

  const keptTasks = new Set(plan.tasks.map((task) => task.todoistId));
  const keptSections = new Set(plan.sections.map((section) => section.todoistId));
  /** @type {{todoist_id: string, completed_at: string}[]} */
  const toComplete = [];
  /** @type {string[]} */
  const toDelete = [];
  for (const row of existing) {
    const todoistId = String(row.todoistId);
    if (todoistId.startsWith(SECTION_PREFIX)) {
      if (!keptSections.has(todoistId)) toDelete.push(todoistId);
      continue;
    }
    if (keptTasks.has(todoistId) || row.completedAt) continue;
    const completedAt = plan.completed.get(todoistId);
    if (completedAt) toComplete.push({ todoist_id: todoistId, completed_at: completedAt });
    else toDelete.push(todoistId);
  }

  if (toComplete.length) {
    await sql`
      UPDATE task_items t
      SET completed_at = r.completed_at::timestamptz, search_indexed_at = NULL, updated_at = now()
      FROM jsonb_to_recordset(${sql.json(toComplete)}) AS r(todoist_id text, completed_at text)
      WHERE t.user_id = ${userId} AND t.todoist_id = r.todoist_id
    `;
  }
  /** @type {string[]} */
  let deletedRootIds = [];
  if (toDelete.length) {
    const deleted = await sql`
      DELETE FROM task_items
      WHERE user_id = ${userId} AND todoist_id = ANY(${toDelete}::text[])
      RETURNING id, kind, parent_id AS "parentId"
    `;
    deletedRootIds = deleted
      .filter((row) => row.kind === 'task' && row.parentId === null)
      .map((row) => String(row.id));
  }

  await registerTaskLabels(sql, userId, plan.labels);

  return {
    summary: {
      projects: plan.projects.length,
      sections: plan.sections.length,
      tasks: plan.tasks.length,
      completed: toComplete.length,
      removed: removedProjects.length + toDelete.length,
      skipped: plan.skipped + unlinkedProjects.length,
    },
    deletedRootIds,
  };
}

// ---------------------------------------------------------------------------
// Search index

/**
 * Pushes every mirrored top-level task the sync left unindexed, in chunks,
 * and drops the documents of the roots it deleted. Best-effort like
 * taskItemMeiliSync.js: never throws, and the weekly drift sweep repairs a
 * miss.
 *
 * @param {import('postgres').Sql} sql
 * @param {any} env
 * @param {string} userId
 * @param {string[]} deletedRootIds
 * @param {{addDocuments?: Function, deleteDocuments?: Function}} [deps]
 */
export async function indexSyncedTasks(sql, env, userId, deletedRootIds, deps = {}) {
  if (!meiliAvailable(env)) return;
  const addDocs = deps.addDocuments ?? addDocuments;
  const deleteDocs = deps.deleteDocuments ?? deleteDocuments;
  try {
    if (deletedRootIds.length) await deleteDocs(env, TASKS_INDEX, deletedRootIds);
    const rows = await sql`
      SELECT t.id, t.user_id, t.content, t.description, t.completed_at, t.updated_at,
             COALESCE(array_agg(c.content ORDER BY c.position, c.created_at)
                        FILTER (WHERE c.id IS NOT NULL), ARRAY[]::text[]) AS subtasks
      FROM task_items t
      LEFT JOIN task_items c ON c.parent_id = t.id
      WHERE t.user_id = ${userId} AND t.todoist_id IS NOT NULL AND t.parent_id IS NULL
        AND t.kind = 'task' AND t.search_indexed_at IS NULL
      GROUP BY t.id
    `;
    for (let start = 0; start < rows.length; start += MEILI_CHUNK_SIZE) {
      const chunk = rows.slice(start, start + MEILI_CHUNK_SIZE);
      await addDocs(env, TASKS_INDEX, chunk);
      await sql`
        UPDATE task_items SET search_indexed_at = now()
        WHERE user_id = ${userId} AND id = ANY(${chunk.map((row) => String(row.id))}::uuid[])
      `;
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'todoist_meili_sync_failed',
        message: /** @type {Error} */ (error).message,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Running a connection

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{status: 'ok' | 'failed', summary?: SyncSummary, error?: string, syncedAt?: Date}} result
 */
export async function recordSyncResult(sql, userId, result) {
  await sql`
    UPDATE todoist_connections SET
      last_synced_at    = CASE WHEN ${result.status === 'ok'}::boolean THEN ${result.syncedAt ?? new Date()} ELSE last_synced_at END,
      last_sync_status  = ${result.status},
      last_sync_error   = ${result.error ? result.error.slice(0, MAX_SYNC_ERROR_LENGTH) : null},
      last_sync_summary = CASE WHEN ${result.status === 'ok'}::boolean THEN ${sql.json(/** @type {any} */ (result.summary ?? null))} ELSE last_sync_summary END,
      updated_at        = now()
    WHERE user_id = ${userId}
  `;
}

export const TOKEN_REJECTED_MESSAGE = 'Todoist rejected the saved token. Enter a new one.';

/**
 * A user-facing line for a failed run, with nothing from the request in it.
 *
 * @param {unknown} error
 */
export function describeSyncFailure(error) {
  if (error instanceof TodoistAuthError) return TOKEN_REJECTED_MESSAGE;
  if (error instanceof TodoistApiError) return `Todoist responded ${error.status}.`;
  if (error instanceof Error && error.name === 'AbortError')
    return 'Todoist took too long to respond.';
  return 'The sync failed. Try again later.';
}

/**
 * One full run for one connection: read Todoist, apply under the owner's
 * task lock, record the outcome, then refresh the search index — deferred
 * onto the request's queue when there is one (the HTTP path), inline
 * otherwise (the cron). The outcome is recorded on failure too, then the
 * error is rethrown for the caller to answer or report.
 *
 * @param {import('postgres').Sql} sql
 * @param {TodoistSyncEnv} env
 * @param {{userId: string, token: string, timeZone: string | null, lastSyncedAt: Date | null}} connection
 * @param {{fetchImpl?: typeof fetch, now?: () => Date}} [deps]
 * @returns {Promise<SyncSummary>}
 */
export async function syncConnection(sql, env, connection, deps = {}) {
  const now = deps.now ? deps.now() : new Date();
  try {
    const snapshot = await fetchSnapshot(connection.token, {
      completedSince: new Date(
        connection.lastSyncedAt
          ? connection.lastSyncedAt.getTime() - COMPLETED_OVERLAP_MS
          : now.getTime() - COMPLETED_LOOKBACK_MS,
      ),
      completedUntil: new Date(now.getTime() + COMPLETED_OVERLAP_MS),
      fetchImpl: deps.fetchImpl,
    });
    const plan = planSync(snapshot, { timeZone: connection.timeZone ?? DEFAULT_TIME_ZONE });
    const { summary, deletedRootIds } = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${connection.userId}, 1))`;
      return applySync(/** @type {any} */ (tx), connection.userId, plan);
    });
    await recordSyncResult(sql, connection.userId, { status: 'ok', summary, syncedAt: now });
    console.log(JSON.stringify({ event: 'todoist_synced', ...summary }));
    if (env.deferSearchSync) {
      env.deferSearchSync(
        (/** @type {import('postgres').Sql} */ freshSql) =>
          indexSyncedTasks(freshSql, env, connection.userId, deletedRootIds),
        `todoist:${connection.userId}`,
      );
    } else {
      await indexSyncedTasks(sql, env, connection.userId, deletedRootIds);
    }
    return summary;
  } catch (error) {
    const message = describeSyncFailure(error);
    console.log(
      JSON.stringify({
        event: 'todoist_sync_failed',
        reason: message,
        status: /** @type {{status?: number}} */ (error)?.status ?? null,
      }),
    );
    await recordSyncResult(sql, connection.userId, { status: 'failed', error: message }).catch(
      () => undefined,
    );
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Schedule

/**
 * Whether an hourly tick falls inside the sync window — 07:00 to 20:00
 * inclusive — in the given zone. The window is judged where the person is,
 * so it follows their daylight-saving changes; the cron itself runs on UTC.
 *
 * @param {Date} instant
 * @param {string | null | undefined} timeZone
 */
export function isSyncHour(instant, timeZone) {
  const zone = isTaskTimeZone(timeZone) ? String(timeZone) : DEFAULT_TIME_ZONE;
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(instant)
      .find(({ type }) => type === 'hour')?.value,
  );
  return Number.isInteger(hour) && hour >= SYNC_START_HOUR && hour <= SYNC_END_HOUR;
}

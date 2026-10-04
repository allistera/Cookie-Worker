import * as z from 'zod';
import { ToolInputError } from '../results.js';
import { provided, READ_ONLY } from './common.js';

const MAX_SPAN_DAYS = 1095;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const OCCURRENCE_ID = /^[^:]+:(\d{4}-\d{2}-\d{2})$/;
// The stored rule is the calendar API's own small format (see
// cookie-web-calendar/src/recurrence.js), not RFC 5545.
const RECURRENCE_RULE =
  /^(DAILY|WEEKLY|MONTHLY|YEARLY)(?:;BYDAY=([A-Z,]+))?(?:;UNTIL=(\d{4}-\d{2}-\d{2}))?$/;
const REPEATS = /** @type {const} */ (['none', 'daily', 'weekly', 'monthly', 'yearly']);
const WEEKDAYS = /** @type {const} */ (['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']);
const TONES = /** @type {const} */ (['default', 'dark', 'conflict', 'accepted', 'suggested']);

const TIMES =
  'Times are local wall-clock times with no timezone. ' +
  'Editing or deleting a recurring event affects the whole series.';

const eventFields = z.object({
  title: z.string().min(1).max(200),
  date: date.describe('Start date, YYYY-MM-DD'),
  start: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM')
    .describe('Start time, 24-hour HH:MM, local wall-clock time'),
  durationMinutes: z.number().int().min(1).max(43_200),
  calendar: z.string().describe('Calendar id from cookie_list_calendars (or a legacy slug)'),
  description: z.string().max(2000).optional(),
  location: z.string().max(200).optional(),
  repeat: z.enum(REPEATS).default('none'),
  repeatUntil: date.nullable().optional().describe('Last date of the series, YYYY-MM-DD'),
  repeatDays: z
    .array(z.enum(WEEKDAYS))
    .min(1)
    .nullable()
    .optional()
    .describe('Weekdays for a weekly repeat; only valid with repeat "weekly"'),
});

/**
 * Maps tool input to the calendar API body (`durationMinutes` is `duration` there),
 * omitting fields the caller did not provide. cookie_list_events reports an
 * absent repeatUntil/repeatDays as null, so null means "none" for those two
 * and a listed event can be resent as it was read.
 * @param {z.infer<typeof eventFields>} fields
 */
function toEventBody(fields) {
  if (fields.repeatDays && fields.repeat !== 'weekly') {
    throw new ToolInputError('repeatDays can only be used with repeat "weekly"');
  }
  const { durationMinutes, repeatUntil, repeatDays, ...rest } = fields;
  return provided({
    ...rest,
    duration: durationMinutes,
    repeatUntil: repeatUntil ?? undefined,
    repeatDays: repeatDays ?? undefined,
  });
}

/**
 * Decodes a stored recurrence rule into the repeat fields the write tools take,
 * so a caller can resend them unchanged.
 * @param {unknown} rule
 */
function decodeRecurrence(rule) {
  const match = typeof rule === 'string' ? rule.match(RECURRENCE_RULE) : null;
  if (!match) return { repeat: 'none', repeatUntil: null, repeatDays: null };
  return {
    repeat: match[1].toLowerCase(),
    repeatUntil: match[3] ?? null,
    repeatDays: match[2] ? match[2].split(',') : null,
  };
}

/**
 * Occurrence ids look like `<seriesUuid>:<YYYY-MM-DD>`, but the write API only
 * accepts the series row id.
 * @param {string} id
 */
function seriesIdOf(id) {
  const series = id.split(':')[0];
  if (!UUID.test(series)) {
    throw new ToolInputError('id must be an event id from cookie_list_events');
  }
  return series;
}

/** @param {string} from @param {string} to */
function assertRange(from, to) {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
  if (!(days >= 0)) throw new ToolInputError('from must not be after to');
  if (days > MAX_SPAN_DAYS) {
    throw new ToolInputError(`The range from..to must be at most ${MAX_SPAN_DAYS} days`);
  }
}

// The event rows carry nulls for unset fields; the schemas must accept them.
const eventOut = z.object({ id: z.string() }).passthrough();

/** @type {import('./types.js').ToolDefinition[]} */
export const tools = [
  {
    name: 'cookie_list_calendars',
    title: 'List calendars',
    description:
      'Lists the owner’s calendars with their ids; readOnly calendars are subscriptions and cannot take events.',
    inputSchema: z.object({}),
    outputSchema: z.object({
      calendars: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          color: z.string().nullable().optional(),
          readOnly: z.boolean(),
        }),
      ),
    }),
    annotations: READ_ONLY,
    async run(_args, api) {
      const body = await api.calendar.get('/calendars');
      return {
        calendars: (body.calendars ?? []).map((/** @type {any} */ c) => ({
          id: c.id,
          name: c.name,
          color: c.color,
          readOnly: Boolean(c.subscriptionUrl),
        })),
      };
    },
  },
  {
    name: 'cookie_list_events',
    title: 'List calendar events',
    description: `Lists events between two dates (at most 1095 days apart), 50 by default, with recurring events expanded into occurrences; truncated is true when more matched, so narrow the dates or raise limit. ${TIMES}`,
    inputSchema: z.object({
      from: date.describe('First date, YYYY-MM-DD'),
      to: date.describe('Last date, YYYY-MM-DD'),
      calendar: z.string().optional().describe('Only events in this calendar id'),
      // Each event can carry a 2,000-character description, which update needs
      // back in full, so the page is kept small instead of trimming the rows.
      limit: z.number().int().min(1).max(500).default(50),
    }),
    outputSchema: z.object({
      events: z.array(
        z
          .object({
            id: z.string(),
            seriesId: z.string().nullable().optional(),
            title: z.string(),
            date: z.string(),
            start: z.string(),
            durationMinutes: z.number(),
            calendar: z.string(),
            location: z.string().nullable().optional(),
            description: z.string().nullable().optional(),
            seriesDate: z.string().optional(),
            tone: z.string().nullable().optional(),
            recurrenceRule: z.string().nullable().optional(),
            repeat: z.enum(REPEATS),
            repeatUntil: z.string().nullable(),
            repeatDays: z.array(z.string()).nullable(),
            allDay: z.boolean().optional(),
          })
          .passthrough(),
      ),
      truncated: z.boolean(),
    }),
    annotations: READ_ONLY,
    async run({ from, to, calendar, limit }, api) {
      assertRange(from, to);
      const body = await api.calendar.get('/calendar-events', { from, to });
      const all = (body.events ?? []).filter(
        (/** @type {any} */ e) => !calendar || e.calendar === calendar,
      );
      return {
        events: all.slice(0, limit).map((/** @type {any} */ e) => ({
          id: e.id,
          seriesId: e.seriesId,
          // Only occurrences of a recurring series carry it: the series start
          // that cookie_update_event needs as date.
          ...(e.seriesDate === undefined ? {} : { seriesDate: e.seriesDate }),
          title: e.title,
          date: e.date,
          start: e.start,
          durationMinutes: e.duration,
          calendar: e.calendar,
          location: e.location,
          description: e.description,
          tone: e.tone,
          recurrenceRule: e.recurrenceRule,
          ...decodeRecurrence(e.recurrenceRule),
          allDay: e.allDay,
        })),
        truncated: Boolean(body.truncated) || all.length > limit,
      };
    },
  },
  {
    name: 'cookie_create_event',
    title: 'Create a calendar event',
    description: `Creates an event (or a repeating series) in a writable calendar. ${TIMES}`,
    inputSchema: eventFields,
    outputSchema: z.object({ event: eventOut }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(args, api) {
      const body = await api.calendar.post('/calendar-events', toEventBody(args));
      return { event: body.event };
    },
  },
  {
    name: 'cookie_update_event',
    title: 'Update a calendar event',
    description:
      'Replaces every field of an event (including repeat and tone), so first read its current ' +
      'values with cookie_list_events and resend the ones you keep. Accepts an event or occurrence ' +
      'id; for a recurring event, pass the seriesDate from cookie_list_events as date (the series ' +
      'start), not the occurrence date (for the first occurrence, pass its seriesId as id). ' +
      TIMES,
    inputSchema: eventFields.extend({
      id: z.string().describe('Event id, or an occurrence id (<seriesId>:<YYYY-MM-DD>)'),
      // Required here: a default would silently strip recurrence from a series.
      repeat: z.enum(REPEATS).describe('Resend the event’s current repeat to keep it'),
      // Required for the same reason: the API replaces every field, so an
      // omitted tone would silently reset the event's colour.
      tone: z
        .enum(TONES)
        .nullable()
        .describe('Event colour tone from cookie_list_events; null for none'),
    }),
    outputSchema: z.object({ event: eventOut }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async run({ id, ...fields }, api) {
      // The API moves the whole series to the given date, so an occurrence's
      // own date would silently shift the series start.
      if (OCCURRENCE_ID.exec(id)?.[1] === fields.date) {
        throw new ToolInputError(
          'For a recurring event, pass its seriesDate as date; editing changes the whole series',
        );
      }
      const body = await api.calendar.patch('/calendar-events', {
        id: seriesIdOf(id),
        ...toEventBody(/** @type {any} */ (fields)),
      });
      return { event: body.event };
    },
  },
  {
    name: 'cookie_delete_event',
    title: 'Delete a calendar event',
    description: `Permanently deletes an event. Passing an occurrence id deletes the whole series. ${TIMES}`,
    inputSchema: z.object({
      id: z.string().describe('Event id, or an occurrence id (<seriesId>:<YYYY-MM-DD>)'),
    }),
    outputSchema: z.object({ deleted: z.literal(true), id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async run({ id }, api) {
      const series = seriesIdOf(id);
      await api.calendar.delete('/calendar-events', { id: series });
      return { deleted: true, id: series };
    },
  },
];

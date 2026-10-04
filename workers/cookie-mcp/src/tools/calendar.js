import * as z from 'zod';
import { ToolInputError } from '../results.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

const MAX_SPAN_DAYS = 1095;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

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
  repeat: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']).default('none'),
  repeatUntil: date.optional().describe('Last date of the series, YYYY-MM-DD'),
  repeatDays: z
    .array(z.enum(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']))
    .min(1)
    .optional()
    .describe('Weekdays for a weekly repeat; only valid with repeat "weekly"'),
});

/**
 * Maps tool input to the calendar API body (`durationMinutes` is `duration` there),
 * omitting fields the caller did not provide.
 * @param {z.infer<typeof eventFields>} fields
 */
function toEventBody(fields) {
  if (fields.repeatDays && fields.repeat !== 'weekly') {
    throw new ToolInputError('repeatDays can only be used with repeat "weekly"');
  }
  const { durationMinutes, ...rest } = fields;
  return Object.fromEntries(
    Object.entries({ ...rest, duration: durationMinutes }).filter(([, v]) => v !== undefined),
  );
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
    description: `Lists events between two dates (at most 1095 days apart), with recurring events expanded into occurrences. ${TIMES}`,
    inputSchema: z.object({
      from: date.describe('First date, YYYY-MM-DD'),
      to: date.describe('Last date, YYYY-MM-DD'),
      calendar: z.string().optional().describe('Only events in this calendar id'),
      limit: z.number().int().min(1).max(1000).default(300),
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
            recurrenceRule: z.string().nullable().optional(),
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
          title: e.title,
          date: e.date,
          start: e.start,
          durationMinutes: e.duration,
          calendar: e.calendar,
          location: e.location,
          description: e.description,
          recurrenceRule: e.recurrenceRule,
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
      'Replaces every field of an event, so first read its current values with cookie_list_events ' +
      'and resend the ones you keep. Accepts an event or occurrence id. ' +
      TIMES,
    inputSchema: eventFields.extend({
      id: z.string().describe('Event id, or an occurrence id (<seriesId>:<YYYY-MM-DD>)'),
    }),
    outputSchema: z.object({ event: eventOut }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async run({ id, ...fields }, api) {
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

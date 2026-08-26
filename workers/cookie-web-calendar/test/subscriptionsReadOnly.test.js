import { beforeEach, describe, expect, it } from 'vitest';

// Ported from Cookie-Web's api/__tests__/calendar-events-subscriptions.test.js
// — same scripted query sequences, same expectations, against the
// Response-style event handlers.
import { createEvent, deleteEvent, updateEvent } from '../src/calendarEvents.js';

/** @type {any[]} */
let sqlQueue = [];
/** @returns {any} */
const makeSql = () => () => Promise.resolve(sqlQueue.shift() ?? []);

const USER_ID = '99999999-9999-9999-9999-999999999999';
const CALENDAR_ID = '11111111-1111-1111-1111-111111111111';
const EVENT_ID = '22222222-2222-2222-2222-222222222222';
const SUBSCRIPTION_URL = 'https://example.com/feed.ics';

const FIELDS = {
  title: 'Test event',
  date: '2026-08-01',
  start: '10:00',
  duration: 30,
  calendar: CALENDAR_ID,
};

describe('subscribed calendars are read-only', () => {
  beforeEach(() => {
    sqlQueue = [];
  });

  it('rejects creating an event in a subscribed calendar with 403', async () => {
    sqlQueue = [[{ id: CALENDAR_ID, subscriptionUrl: SUBSCRIPTION_URL }]];
    const response = await createEvent(makeSql(), USER_ID, FIELDS);

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('read-only');
  });

  it('allows creating an event in a normal calendar', async () => {
    sqlQueue = [[{ id: CALENDAR_ID, subscriptionUrl: null }], [{ id: EVENT_ID, ...FIELDS }]];
    const response = await createEvent(makeSql(), USER_ID, FIELDS);

    expect(response.status).toBe(201);
  });

  it('rejects updating an event whose target calendar is subscribed', async () => {
    sqlQueue = [[{ id: CALENDAR_ID, subscriptionUrl: SUBSCRIPTION_URL }]];
    const response = await updateEvent(makeSql(), USER_ID, { id: EVENT_ID, ...FIELDS });

    expect(response.status).toBe(403);
  });

  it('rejects updating an event currently in a subscribed calendar, even moving it elsewhere', async () => {
    sqlQueue = [[{ id: CALENDAR_ID, subscriptionUrl: null }], [{ isSubscribed: true }]];
    const response = await updateEvent(makeSql(), USER_ID, { id: EVENT_ID, ...FIELDS });

    expect(response.status).toBe(403);
  });

  it('rejects deleting an event that lives in a subscribed calendar', async () => {
    sqlQueue = [[{ isSubscribed: true }]];
    const response = await deleteEvent(makeSql(), USER_ID, { id: EVENT_ID });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('read-only');
  });

  it('allows deleting an event in a normal calendar', async () => {
    sqlQueue = [[{ isSubscribed: false }], [{ id: EVENT_ID }]];
    const response = await deleteEvent(makeSql(), USER_ID, { id: EVENT_ID });

    expect(response.status).toBe(200);
  });
});

export const ENRICHMENT_TIME_ZONE = 'Europe/London';
export const ENRICHMENT_MODELS = ['gpt-5-nano', 'gpt-5.6-luna', 'gpt-4.1-nano'];
export const ENRICHMENT_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const ENRICHMENT_INTERVALS = [1, 2, 3, 4, 6, 12];

export const DEFAULT_ENRICHMENT_SETTINGS = Object.freeze({
  model: 'gpt-5-nano',
  schedule: Object.freeze({
    enabled: true,
    days: Object.freeze([...ENRICHMENT_DAYS]),
    startHour: 9,
    endHour: 19,
    intervalHours: 1,
    timezone: ENRICHMENT_TIME_ZONE,
  }),
});

function defaultSettings(fallbackModel) {
  return {
    model: ENRICHMENT_MODELS.includes(fallbackModel)
      ? fallbackModel
      : DEFAULT_ENRICHMENT_SETTINGS.model,
    schedule: {
      ...DEFAULT_ENRICHMENT_SETTINGS.schedule,
      days: [...DEFAULT_ENRICHMENT_SETTINGS.schedule.days],
    },
  };
}

/** Safely reads persisted settings, falling back field-by-field for old/malformed prefs. */
export function normalizeEnrichmentSettings(input, fallbackModel) {
  const defaults = defaultSettings(fallbackModel);
  const schedule = input?.schedule;
  const days = Array.isArray(schedule?.days)
    ? [...new Set(schedule.days.filter((day) => ENRICHMENT_DAYS.includes(day)))]
    : [];
  return {
    model: ENRICHMENT_MODELS.includes(input?.model) ? input.model : defaults.model,
    schedule: {
      enabled:
        typeof schedule?.enabled === 'boolean' ? schedule.enabled : defaults.schedule.enabled,
      days: days.length ? days : defaults.schedule.days,
      startHour:
        Number.isInteger(schedule?.startHour) && schedule.startHour >= 0 && schedule.startHour <= 23
          ? schedule.startHour
          : defaults.schedule.startHour,
      endHour:
        Number.isInteger(schedule?.endHour) && schedule.endHour >= 0 && schedule.endHour <= 23
          ? schedule.endHour
          : defaults.schedule.endHour,
      intervalHours: ENRICHMENT_INTERVALS.includes(schedule?.intervalHours)
        ? schedule.intervalHours
        : defaults.schedule.intervalHours,
      timezone: ENRICHMENT_TIME_ZONE,
    },
  };
}

/** Strict validation for the settings API. */
export function validateEnrichmentSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'enrichmentSettings must be an object' };
  }
  if (!ENRICHMENT_MODELS.includes(input.model)) {
    return { error: 'model is not supported' };
  }
  const schedule = input.schedule;
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    return { error: 'schedule must be an object' };
  }
  if (typeof schedule.enabled !== 'boolean') {
    return { error: 'schedule.enabled must be a boolean' };
  }
  if (
    !Array.isArray(schedule.days) ||
    schedule.days.length === 0 ||
    schedule.days.some((day) => !ENRICHMENT_DAYS.includes(day))
  ) {
    return { error: 'schedule.days must contain supported days' };
  }
  if (
    !Number.isInteger(schedule.startHour) ||
    schedule.startHour < 0 ||
    schedule.startHour > 23 ||
    !Number.isInteger(schedule.endHour) ||
    schedule.endHour < 0 ||
    schedule.endHour > 23 ||
    schedule.startHour > schedule.endHour
  ) {
    return { error: 'schedule hours must be between 0 and 23, with start before end' };
  }
  if (!ENRICHMENT_INTERVALS.includes(schedule.intervalHours)) {
    return { error: 'schedule.intervalHours is not supported' };
  }
  if (schedule.timezone !== undefined && schedule.timezone !== ENRICHMENT_TIME_ZONE) {
    return { error: `schedule.timezone must be ${ENRICHMENT_TIME_ZONE}` };
  }
  return {
    value: {
      model: input.model,
      schedule: {
        enabled: schedule.enabled,
        days: ENRICHMENT_DAYS.filter((day) => schedule.days.includes(day)),
        startHour: schedule.startHour,
        endHour: schedule.endHour,
        intervalHours: schedule.intervalHours,
        timezone: ENRICHMENT_TIME_ZONE,
      },
    },
  };
}

const WEEKDAY_KEYS = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};
const LOCAL_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: ENRICHMENT_TIME_ZONE,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

function localSlot(instant) {
  const parts = Object.fromEntries(
    LOCAL_PARTS.formatToParts(instant)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value]),
  );
  return {
    key: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`,
    day: WEEKDAY_KEYS[parts.weekday],
    hour: Number(parts.hour),
  };
}

/** Returns whether an hourly UTC cron invocation maps to an enabled UK-local slot. */
export function isEnrichmentDue(input, instant = new Date()) {
  const settings = normalizeEnrichmentSettings(input);
  const { schedule } = settings;
  if (!schedule.enabled) return false;
  const slot = localSlot(instant);
  if (!schedule.days.includes(slot.day)) return false;
  if (slot.hour < schedule.startHour || slot.hour > schedule.endHour) return false;
  if ((slot.hour - schedule.startHour) % schedule.intervalHours !== 0) return false;

  // When UK clocks go back, two UTC hours map to the same local 01:00 slot.
  // Run the first and skip the repeated one so every configured slot runs once.
  const previousSlot = localSlot(new Date(instant.getTime() - 60 * 60 * 1000));
  return previousSlot.key !== slot.key;
}

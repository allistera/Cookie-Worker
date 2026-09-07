// Stored in users.prefs.autoArchive; activation dates prevent backlog processing.
export const AUTO_ARCHIVE_CATEGORIES = ['marketing', 'coldPitches', 'socialNoise'];
export const AUTO_ARCHIVE_THRESHOLD = 0.95;
const EXCLUSIONS =
  ' Never match personal correspondence, direct messages, receipts, invoices, order or delivery updates, appointments, security alerts or account problems. If uncertain, do not match.';
const PROMPTS = {
  marketing:
    'Promotional marketing, sales offers, discount campaigns and bulk newsletters.' + EXCLUSIONS,
  coldPitches:
    'Unsolicited commercial sales or service pitches, including personalised cold outreach. Not an ongoing conversation or a requested quote.' +
    EXCLUSIONS,
  socialNoise:
    'Automated social-network activity digests, likes, follows, suggested connections and engagement notifications. Not direct messages or messages requesting a personal response.' +
    EXCLUSIONS,
};

/** @param {any} stored @param {string} category */
export function autoArchiveSince(stored, category) {
  const value = stored?.[category];
  return value?.enabled === true &&
    typeof value.since === 'string' &&
    Number.isFinite(Date.parse(value.since))
    ? value.since
    : null;
}

/** @param {any} stored */
export function autoArchiveSettings(stored) {
  return Object.fromEntries(
    AUTO_ARCHIVE_CATEGORIES.map((category) => [
      category,
      autoArchiveSince(stored, category) !== null,
    ]),
  );
}

/** @param {any} stored @param {Record<string, boolean>} flags @param {string} now */
export function updateAutoArchive(stored, flags, now) {
  return Object.fromEntries(
    AUTO_ARCHIVE_CATEGORIES.map((category) => [
      category,
      {
        enabled: flags[category],
        since: flags[category] ? (autoArchiveSince(stored, category) ?? now) : null,
      },
    ]),
  );
}

/** @param {any} stored @param {any} createdAt */
export function autoArchiveRules(stored, createdAt) {
  const received = new Date(createdAt).getTime();
  return AUTO_ARCHIVE_CATEGORIES.filter((category) => {
    const since = autoArchiveSince(stored, category);
    return since !== null && received >= Date.parse(since);
  }).map((category) => ({
    id: `auto-archive:${category}`,
    prompt: PROMPTS[category],
    action: 'mark_done',
    label_id: null,
    autoArchiveCategory: category,
  }));
}

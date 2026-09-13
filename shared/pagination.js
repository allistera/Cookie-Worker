export function encodeCursor(values) {
  return btoa(JSON.stringify(values)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeCursor(value, validate) {
  if (!value) return null;
  if (value.length > 2048) throw new Error('Invalid cursor');
  const decoded = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')));
  if (!validate(decoded)) throw new Error('Invalid cursor');
  return decoded;
}

export const validId = (value) =>
  typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
export const validTimestamp = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
export const timestamp = (value) => (value instanceof Date ? value.toISOString() : value);

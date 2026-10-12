export const attemptPattern =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const attemptId = new RegExp(attemptPattern);
export const isAttemptId = (value: unknown): value is string =>
  typeof value === 'string' && attemptId.test(value);
export const isText = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && !value.includes('\0');

export const isScopeName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);

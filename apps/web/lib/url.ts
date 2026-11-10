/**
 * Pure parsers for the three public env vars. They live apart from site.ts so they can be unit
 * tested without touching process.env, and so a bad value degrades to a safe default instead of
 * shipping a broken link.
 */

/** A checkout link is only accepted when it is a plain https URL. Anything else counts as "not on sale". */
export function parseCheckoutUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** GitHub "owner/repo". Rejects anything that is not exactly two safe path segments. */
export function parseRepo(raw: string | undefined, fallback: string): string {
  const value = raw?.trim();
  if (value && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return value;
  return fallback;
}

/** Site origin without a trailing slash or path. Falls back when empty or malformed. */
export function parseOrigin(raw: string | undefined, fallback: string): string {
  const value = raw?.trim();
  if (!value) return fallback;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback;
    return url.origin;
  } catch {
    return fallback;
  }
}

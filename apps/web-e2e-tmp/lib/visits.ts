/**
 * Anonymous unique-visitor counter, backed by a Redis HyperLogLog on Upstash (plain REST over fetch, no SDK).
 *
 *  - A visitor is the SHA-256 of (IP + user agent + a secret salt). The raw IP is never stored or logged, and a
 *    HyperLogLog cannot list its members, so the counter cannot be turned back into a list of visitors.
 *  - POST adds the visitor and returns the count; GET only reads it (cached for 60 s).
 *  - POST is same-origin only and the body is ignored (and size-checked), so there is nothing to abuse.
 *  - Without all three env vars the whole feature is off: the route answers 404 and the UI renders nothing.
 */

export const VISITORS_KEY = 'visitors';
export const MAX_BODY_BYTES = 1024;
const CACHE_SECONDS = 60;

export interface VisitEnv {
  url: string;
  token: string;
  salt: string;
}

type EnvSource = Record<string, string | undefined>;

/** All three variables must be present, and the Upstash URL must be https. Otherwise the counter is off. */
export function readVisitEnv(env: EnvSource): VisitEnv | null {
  const url = env.UPSTASH_REDIS_REST_URL?.trim().replace(/\/+$/, '');
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  const salt = env.VISITOR_SALT?.trim();
  if (!url || !token || !salt) return null;
  try {
    if (new URL(url).protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { url, token, salt };
}

/** First hop of x-forwarded-for (set by Vercel's proxy), then x-real-ip, else "unknown". */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || headers.get('x-real-ip')?.trim() || 'unknown';
}

export async function visitorHash(ip: string, userAgent: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${ip}|${userAgent}|${salt}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Browsers send Sec-Fetch-Site on fetch(); fall back to comparing Origin with the request host. */
export function isSameOrigin(headers: Headers, requestUrl: string): boolean {
  const site = headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = headers.get('origin');
  if (!origin) return false;
  try {
    const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? new URL(requestUrl).host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

type Command = string[];
type FetchLike = typeof fetch;

async function pipeline(env: VisitEnv, commands: Command[], fetchImpl: FetchLike): Promise<number> {
  const res = await fetchImpl(`${env.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  const results = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  const last = results[results.length - 1];
  if (!last || typeof last.result !== 'number') throw new Error('upstash result');
  return last.result;
}

const json = (body: unknown, status: number, cache: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
  });

const NO_STORE = 'no-store';

/** The whole route, with its dependencies passed in so it can be tested without a network. */
export async function handleVisits(
  request: Request,
  env: VisitEnv | null,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  if (!env) return json({ error: 'disabled' }, 404, NO_STORE);

  try {
    if (request.method === 'GET') {
      const count = await pipeline(env, [['PFCOUNT', VISITORS_KEY]], fetchImpl);
      return json({ count }, 200, `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=300`);
    }

    if (request.method === 'POST') {
      if (!isSameOrigin(request.headers, request.url)) return json({ error: 'forbidden' }, 403, NO_STORE);
      const length = Number(request.headers.get('content-length') ?? 0);
      if (!Number.isFinite(length) || length > MAX_BODY_BYTES) return json({ error: 'too large' }, 413, NO_STORE);

      const hash = await visitorHash(
        clientIp(request.headers),
        request.headers.get('user-agent') ?? '',
        env.salt,
      );
      const count = await pipeline(
        env,
        [
          ['PFADD', VISITORS_KEY, hash],
          ['PFCOUNT', VISITORS_KEY],
        ],
        fetchImpl,
      );
      return json({ count }, 200, NO_STORE);
    }

    return json({ error: 'method not allowed' }, 405, NO_STORE);
  } catch {
    // Never leak upstream details (URLs, tokens, error text).
    return json({ error: 'unavailable' }, 502, NO_STORE);
  }
}

/** Server-side switch used by the layout: render the pill only when the counter can work. */
export function visitorCounterEnabled(env: EnvSource = process.env): boolean {
  return readVisitEnv(env) !== null;
}

import { describe, expect, it, vi } from 'vitest';
import {
  clientIp,
  handleVisits,
  isSameOrigin,
  readVisitEnv,
  visitorCounterEnabled,
  visitorHash,
  networkOf,
  monthOf,
  type VisitEnv,
} from './visits';

const ENV: VisitEnv = {
  url: 'https://example-123.upstash.io',
  token: 'secret-token',
  salt: 'pepper',
};
const URL_ = 'https://polishot.app/api/visits';

function upstash(...results: number[]) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(results.map((result) => ({ result }))), { status: 200 }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function post(headers: Record<string, string> = {}) {
  return new Request(URL_, {
    method: 'POST',
    headers: {
      'sec-fetch-site': 'same-origin',
      'x-forwarded-for': '203.0.113.7, 10.0.0.1',
      'user-agent': 'TestBrowser/1.0',
      ...headers,
    },
  });
}

describe('readVisitEnv', () => {
  it('needs all three values', () => {
    expect(
      readVisitEnv({
        UPSTASH_REDIS_REST_URL: 'https://x.upstash.io/',
        UPSTASH_REDIS_REST_TOKEN: 't',
        VISITOR_SALT: 's',
      }),
    ).toEqual({ url: 'https://x.upstash.io', token: 't', salt: 's' });
    expect(readVisitEnv({})).toBeNull();
    expect(
      readVisitEnv({
        UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 't',
      }),
    ).toBeNull();
    expect(readVisitEnv({ UPSTASH_REDIS_REST_TOKEN: 't', VISITOR_SALT: 's' })).toBeNull();
    expect(
      readVisitEnv({
        UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: '  ',
        VISITOR_SALT: 's',
      }),
    ).toBeNull();
  });

  it('rejects a non-https Upstash URL', () => {
    expect(
      readVisitEnv({
        UPSTASH_REDIS_REST_URL: 'http://x.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 't',
        VISITOR_SALT: 's',
      }),
    ).toBeNull();
    expect(
      readVisitEnv({
        UPSTASH_REDIS_REST_URL: 'not a url',
        UPSTASH_REDIS_REST_TOKEN: 't',
        VISITOR_SALT: 's',
      }),
    ).toBeNull();
  });

  it('drives the on/off switch used by the layout', () => {
    expect(visitorCounterEnabled({})).toBe(false);
    expect(
      visitorCounterEnabled({
        UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 't',
        VISITOR_SALT: 's',
      }),
    ).toBe(true);
  });
});

describe('visitorHash', () => {
  it('is a stable SHA-256 hex digest', async () => {
    const a = await visitorHash('203.0.113.7', 'salt', '2026-11');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await visitorHash('203.0.113.7', 'salt', '2026-11')).toBe(a);
  });

  it('changes with the network, the salt and the month, never with anything a client can vary', async () => {
    const base = await visitorHash('203.0.113.7', 'salt', '2026-11');
    expect(await visitorHash('203.0.113.8', 'salt', '2026-11')).not.toBe(base);
    expect(await visitorHash('203.0.113.7', 'other', '2026-11')).not.toBe(base);
    expect(await visitorHash('203.0.113.7', 'salt', '2026-12')).not.toBe(base);
  });

  it('treats one IPv6 /64 as one visitor', async () => {
    expect(networkOf('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(networkOf('203.0.113.7')).toBe('203.0.113.7');
    expect(await visitorHash('2001:db8:1:2::1', 's', 'm')).toBe(
      await visitorHash('2001:db8:1:2:ffff::9', 's', 'm'),
    );
  });

  it('uses the UTC month', () => {
    expect(monthOf(new Date(Date.UTC(2026, 10, 30, 23, 59)))).toBe('2026-11');
    expect(monthOf(new Date(Date.UTC(2027, 0, 1)))).toBe('2027-01');
  });

  it('does not contain the address', async () => {
    const hash = await visitorHash('203.0.113.7', 'salt', '2026-11');
    expect(hash).not.toContain('203');
    expect(hash).not.toContain('113');
  });
});

describe('clientIp', () => {
  it('uses the first forwarded address, then x-real-ip, then "unknown"', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': ' 198.51.100.4 , 10.0.0.1' }))).toBe(
      '198.51.100.4',
    );
    expect(clientIp(new Headers({ 'x-real-ip': '198.51.100.9' }))).toBe('198.51.100.9');
    expect(clientIp(new Headers())).toBe('unknown');
  });
});

describe('isSameOrigin', () => {
  it('trusts Sec-Fetch-Site when present', () => {
    expect(isSameOrigin(new Headers({ 'sec-fetch-site': 'same-origin' }), URL_)).toBe(true);
    expect(isSameOrigin(new Headers({ 'sec-fetch-site': 'cross-site' }), URL_)).toBe(false);
    expect(isSameOrigin(new Headers({ 'sec-fetch-site': 'same-site' }), URL_)).toBe(false);
  });

  it('falls back to comparing Origin with the host', () => {
    expect(
      isSameOrigin(new Headers({ origin: 'https://polishot.app', host: 'polishot.app' }), URL_),
    ).toBe(true);
    expect(
      isSameOrigin(new Headers({ origin: 'https://evil.test', host: 'polishot.app' }), URL_),
    ).toBe(false);
    expect(isSameOrigin(new Headers({ host: 'polishot.app' }), URL_)).toBe(false);
    expect(isSameOrigin(new Headers({ origin: 'null', host: 'polishot.app' }), URL_)).toBe(false);
  });
});

describe('handleVisits', () => {
  it('answers 404 and never calls out when the counter is not configured', async () => {
    const fetchMock = upstash(1);
    const res = await handleVisits(post(), null, fetchMock);
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    const get = await handleVisits(new Request(URL_), null, fetchMock);
    expect(get.status).toBe(404);
  });

  it('POST rate-limits per network, then adds a salted hash (never the raw IP) and returns the count', async () => {
    // First pipeline answers the rate counter (1 call so far), the second the visitor count.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ result: 'OK' }, { result: 1 }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ result: 1 }, { result: 12483 }])));
    const res = await handleVisits(post(), ENV, fetchMock as unknown as typeof fetch);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 12483 });
    expect(res.headers.get('cache-control')).toBe('no-store');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://example-123.upstash.io/pipeline');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');

    const body = String(init.body);
    const commands = JSON.parse(body) as string[][];
    const month = new Date().toISOString().slice(0, 7);
    const expected = await visitorHash('203.0.113.7', 'pepper', month);
    expect(commands).toEqual([
      ['PFADD', 'visitors', expected],
      ['PFCOUNT', 'visitors'],
    ]);
    const rate = JSON.parse(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
    ) as string[][];
    expect(rate[0]?.slice(0, 2)).toEqual(['SET', `visitors:rl:${expected}`]);
    expect(rate[1]).toEqual(['INCR', `visitors:rl:${expected}`]);
    for (const b of [body, String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)]) {
      expect(b).not.toContain('203.0.113.7');
      expect(b).not.toContain('pepper');
      expect(b).not.toContain('TestBrowser');
    }
  });

  it('past the per-network limit, POST only reads the count', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ result: null }, { result: 6 }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ result: 77 }])));
    const res = await handleVisits(post(), ENV, fetchMock as unknown as typeof fetch);
    expect(await res.json()).toEqual({ count: 77 });
    const second = JSON.parse(
      String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body),
    ) as string[][];
    expect(second).toEqual([['PFCOUNT', 'visitors']]);
  });

  it('GET with a query string is refused, so the CDN cache cannot be bypassed', async () => {
    const fetchMock = upstash(1);
    const res = await handleVisits(new Request(`${URL_}?cb=123`), ENV, fetchMock);
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET only reads the count and may be cached for 60 seconds', async () => {
    const fetchMock = upstash(4821);
    const res = await handleVisits(new Request(URL_), ENV, fetchMock);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 4821 });
    expect(res.headers.get('cache-control')).toContain('s-maxage=60');
    const commands = JSON.parse(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
    ) as string[][];
    expect(commands).toEqual([['PFCOUNT', 'visitors']]);
  });

  it('refuses cross-site POSTs without touching Redis', async () => {
    const fetchMock = upstash(1, 2);
    const res = await handleVisits(post({ 'sec-fetch-site': 'cross-site' }), ENV, fetchMock);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a POST without any origin information', async () => {
    const fetchMock = upstash(1, 2);
    const request = new Request(URL_, {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect((await handleVisits(request, ENV, fetchMock)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an oversized body', async () => {
    const fetchMock = upstash(1, 2);
    const res = await handleVisits(post({ 'content-length': '5000' }), ENV, fetchMock);
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects other methods', async () => {
    const fetchMock = upstash(1);
    const res = await handleVisits(new Request(URL_, { method: 'DELETE' }), ENV, fetchMock);
    expect(res.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a bare 502 when Redis fails, without leaking details', async () => {
    const failing = vi.fn(
      async () => new Response('token=secret-token boom', { status: 500 }),
    ) as unknown as typeof fetch;
    const res = await handleVisits(post(), ENV, failing);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('upstash');
  });

  it('returns 502 when fetch throws or the reply is malformed', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect((await handleVisits(post(), ENV, throwing)).status).toBe(502);

    const malformed = vi.fn(
      async () => new Response(JSON.stringify([{ result: 'x' }]), { status: 200 }),
    ) as unknown as typeof fetch;
    expect((await handleVisits(new Request(URL_), ENV, malformed)).status).toBe(502);
  });
});

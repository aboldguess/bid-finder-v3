// The one place outbound requests to procurement portals are made. Every
// request is identified by our User-Agent, spaced out per host, retried with
// backoff (honouring Retry-After), and optionally checked against robots.txt
// and the private-network guard.
import { config } from '../config.js';
import { log } from '../log.js';
import { parseRobots, robotsDecision } from './robots.js';
import { assertPublicUrl } from './ssrf.js';

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Keeps API keys out of error messages, which are stored and shown to admins.
export const redact = (url) => String(url).replace(/([?&](?:api_?key|key|token|access_token)=)[^&]+/gi, '$1***');

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextSlot = new Map(); // host -> earliest time of the next request
const robotsCache = new Map(); // origin -> { groups, at }
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_BYTES = 60 * 1024 * 1024;

// A cookie jar is a Map of host -> Map of cookie name -> value. It is enough
// for form logins; it deliberately ignores paths, expiry and subdomains.
export const createJar = () => new Map();
function storeCookies(jar, host, headers) {
  const set = headers.getSetCookie?.() || [];
  if (!set.length) return;
  const cookies = jar.get(host) || new Map();
  for (const line of set) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  jar.set(host, cookies);
}
const cookieHeader = (jar, host) => [...(jar.get(host) || [])].map(([k, v]) => `${k}=${v}`).join('; ');

export function createHttp({
  fetchImpl = (...a) => fetch(...a),
  userAgent = config.userAgent,
  minDelayMs = 1000,
  respectRobots = false,
  guard = false,
  retries = 3,
  sleep = realSleep,
  lookup,
} = {}) {
  async function throttle(host, delayMs) {
    const now = Date.now();
    const at = Math.max(now, nextSlot.get(host) || 0);
    nextSlot.set(host, at + delayMs);
    if (at > now) await sleep(at - now);
  }

  async function robotsFor(origin) {
    const hit = robotsCache.get(origin);
    if (hit && Date.now() - hit.at < 24 * 3600e3) return hit.groups;
    let groups = [];
    try {
      const res = await fetchImpl(`${origin}/robots.txt`, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(15000) });
      // 4xx means "no restrictions"; 5xx means "assume disallowed" (RFC 9309).
      if (res.ok) groups = parseRobots(await res.text());
      else if (res.status >= 500) groups = parseRobots('User-agent: *\nDisallow: /');
    } catch {
      groups = [];
    }
    robotsCache.set(origin, { groups, at: Date.now() });
    return groups;
  }

  async function once(url, { method, headers, body, timeoutMs, jar }) {
    const target = guard ? await assertPublicUrl(url, lookup ? { lookup } : undefined) : new URL(url);
    let delay = minDelayMs;
    if (respectRobots) {
      const { allowed, crawlDelay } = robotsDecision(await robotsFor(target.origin), 'BidFinder', target.pathname + target.search);
      if (!allowed) throw new HttpError(`robots.txt at ${target.host} disallows ${target.pathname}`, 0);
      if (crawlDelay) delay = Math.max(delay, Math.min(crawlDelay, 60) * 1000);
    }
    await throttle(target.host, delay);
    const cookie = jar ? cookieHeader(jar, target.host) : '';
    const res = await fetchImpl(target.href, {
      method,
      body,
      headers: { 'User-Agent': userAgent, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    if (jar) storeCookies(jar, target.host, res.headers);
    return res;
  }

  // Returns { status, headers, text, url }. Follows redirects itself so each
  // hop is throttled, guarded and can set cookies.
  async function request(url, { method = 'GET', headers = {}, body, accept, timeoutMs = 30000, jar, okStatuses } = {}) {
    const baseHeaders = { ...(accept ? { Accept: accept } : {}), ...headers };
    let current = url;
    let currentMethod = method;
    let currentBody = body;
    for (let hop = 0; hop < 6; hop++) {
      let res;
      for (let attempt = 0; ; attempt++) {
        let failure;
        try {
          res = await once(current, { method: currentMethod, headers: baseHeaders, body: currentBody, timeoutMs, jar });
          if (!RETRYABLE.has(res.status)) break;
          failure = new HttpError(`HTTP ${res.status} from ${redact(current)}`, res.status);
        } catch (err) {
          if (err instanceof HttpError || /not allowed|Not a valid URL|Could not resolve/.test(err.message)) throw err;
          // fetch() reports network faults as "fetch failed"; the cause says which (DNS, TLS, refused).
          const cause = err.cause?.code || err.cause?.message;
          failure = new HttpError(`${err.name === 'TimeoutError' ? 'Timed out' : err.message}${cause && err.name !== 'TimeoutError' ? ` (${cause})` : ''} fetching ${redact(current)}`, 0);
        }
        if (attempt >= retries) throw failure;
        const retryAfter = Number(res?.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 180) * 1000 : 1000 * 2 ** attempt + Math.random() * 500;
        log.debug(`${failure.message}; retrying in ${Math.round(wait)} ms`);
        await sleep(wait);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).href;
        if (res.status !== 307 && res.status !== 308) { currentMethod = 'GET'; currentBody = undefined; delete baseHeaders['Content-Type']; }
        continue;
      }
      if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new HttpError(`Response from ${redact(current)} is too large`, res.status);
      const text = await res.text();
      const ok = okStatuses ? okStatuses.includes(res.status) : res.ok;
      if (!ok) throw new HttpError(`HTTP ${res.status} from ${redact(current)}`, res.status);
      return { status: res.status, headers: res.headers, text, url: current };
    }
    throw new HttpError(`Too many redirects from ${redact(url)}`, 0);
  }

  const get = async (url, opts) => (await request(url, opts)).text;
  return { request, get };
}

// For tests.
export function resetHttpState() {
  nextSlot.clear();
  robotsCache.clear();
}

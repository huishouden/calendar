import type { Env } from './env';
import { log } from './log';
import { feedId, feedOwner, loadPerson, openFeedBody, type FeedRow } from './store';
import { FEED, FEED_MAX_AGE_MS, markWork } from './work';

/**
 * The subscribed feed: `GET /feed/<secret>.ics` (also as `webcal://`). It serves the feed the work
 * built when the person's calendar last changed (src/work.ts `buildFeed`), stored sealed for this
 * URL, with its `ETag` (304 when the client has it). A request never asks Firestore and never builds
 * a feed: at most it marks one stale, for the next check to rebuild:
 *
 * - a feed older than FEED_MAX_AGE_MS is rebuilt after the next check even if nothing seems to have
 *   changed (in case a change slipped past the signal);
 * - each request asks for a check of its person (feed only: people with Google are checked every few minutes anyway) (`env.SELF.check`, its own invocation, after the
 *   answer), at most every CHECK_ON_FETCH_MS per person: a change (their settings in the portal, an
 *   item) is built within seconds of the calendar app asking, ready for its next fetch;
 * - a feed not built yet (set up before the scale-out, or its build failed) is built in its own
 *   invocation while the request waits; failing that, 503 with `Retry-After`, and calendar apps try
 *   again.
 *
 * So the request's own CPU time is a hash, one D1 read and an AES-GCM open, whatever the calendar.
 */

/** A request asks for a check of its person at most this often (per isolate). */
export const CHECK_ON_FETCH_MS = 5_000;
const asked = new Map<string, number>();

export const FEED_PATH = /^\/feed\/([A-Za-z0-9_-]{20,64})\.ics$/;

export const feedUrl = (origin: string, secret: string) => `${origin}/feed/${secret}.ics`;

const notFound = () => new Response('No such calendar. Set it up again in Huishouden: Settings > Calendar.\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

/** Seconds a client is asked to wait for a feed that is being made. */
export const PENDING_RETRY_S = 60;

function respond(request: Request, body: string | null, etag: string): Response {
  const headers = {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="huishouden.ics"',
    ETag: etag,
    'Cache-Control': 'private, max-age=300',
    'X-Robots-Tag': 'noindex',
  };
  const match = request.headers.get('If-None-Match');
  if (match && match.split(',').some((t) => t.trim() === etag)) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}

export async function serveFeed(env: Env, request: Request, secret: string, { now = Date.now(), ctx }: { now?: number; ctx?: Pick<ExecutionContext, 'waitUntil'> } = {}): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(secret)) return notFound();
  const id = await feedId(secret);
  const row = await env.DB.prepare('SELECT pid, etag, body, built_at, stale FROM feeds WHERE id = ?').bind(id).first<Pick<FeedRow, 'pid' | 'etag' | 'body' | 'built_at' | 'stale'>>();
  const later = (p: Promise<unknown>) => (ctx ? ctx.waitUntil(p.catch(() => undefined)) : p.catch(() => undefined));
  if (row) {
    if (!row.stale && now - row.built_at > FEED_MAX_AGE_MS) await later(env.DB.prepare('UPDATE feeds SET stale = 1 WHERE id = ?').bind(id).run());
    if (env.SELF && now - (asked.get(row.pid) ?? 0) > CHECK_ON_FETCH_MS) {
      if (asked.size > 1000) asked.clear();
      asked.set(row.pid, now);
      const self = env.SELF;
      // People with Google are checked every few minutes anyway.
      await later(
        (async () => {
          const person = await env.DB.prepare('SELECT google FROM people WHERE pid = ?').bind(row.pid).first<{ google: number }>();
          if (person && !person.google) await self.check([row.pid]);
        })(),
      );
    }
    const match = request.headers.get('If-None-Match');
    if (match && match.split(',').some((t) => t.trim() === row.etag)) {
      log('feed', { served: 'not-modified' });
      return respond(request, null, row.etag);
    }
    const body = request.method === 'HEAD' ? '' : await openFeedBody(env, secret, row.body);
    if (body !== null) {
      log('feed', { served: 'stored' });
      return respond(request, body, row.etag);
    }
  }
  // Nothing stored for this URL yet: is it a feed at all?
  const pid = await feedOwner(env, secret);
  if (!pid) return notFound();
  const record = await loadPerson(env, pid);
  if (!record || record.feed?.secret !== secret) return notFound();
  if (env.SELF) {
    await markWork(env, pid, FEED, now, { queue: false });
    const outcome = await env.SELF.work(pid).catch(() => null);
    const built = outcome && 'done' in outcome ? await env.DB.prepare('SELECT etag, body FROM feeds WHERE id = ?').bind(id).first<Pick<FeedRow, 'etag' | 'body'>>() : null;
    const body = built ? (request.method === 'HEAD' ? '' : await openFeedBody(env, secret, built.body)) : null;
    if (built && body !== null) {
      log('feed', { served: 'built-now' });
      return respond(request, body, built.etag);
    }
  }
  await markWork(env, pid, FEED, now);
  log('feed', { served: 'pending' });
  return new Response('Your calendar is being made. Try again in a minute.\n', { status: 503, headers: { 'Retry-After': String(PENDING_RETRY_S), 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

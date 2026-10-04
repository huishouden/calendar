import { contentHash, exportEvents, exportIcs, loadExportLang } from '@huishouden/pwa-kit/calendar-export';
import { icsProblems } from '@huishouden/pwa-kit/ics';
import type { Env, Fetch } from './env';
import { log } from './log';
import { NotMember, Person, signInGone } from './person';
import { feedOwner, loadPerson, revokeFeed, savePerson, upsertPersonRow, type PersonRecord } from './store';

/**
 * The subscribed feed: `GET /feed/<secret>.ics` (also as `webcal://`). The secret finds the person;
 * the calendar is worked out as them, in their language and time zone, with their settings. While
 * nothing changed (the person's change signal, src/person.ts) the last one is served again from D1,
 * and a client that sends its ETag back gets 304.
 */

export const FEED_PATH = /^\/feed\/([A-Za-z0-9_-]{20,64})\.ics$/;

export const feedUrl = (origin: string, secret: string) => `${origin}/feed/${secret}.ics`;

const notFound = () => new Response('No such calendar. Set it up again in Huishouden: Settings > Calendar.\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

interface Cached {
  signal: string;
  etag: string;
  body: string;
}

async function cached(env: Env, pid: string): Promise<Cached | null> {
  return env.DB.prepare('SELECT signal, etag, body FROM feeds WHERE pid = ?').bind(pid).first<Cached>();
}

function respond(request: Request, body: string, etag: string): Response {
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

export async function serveFeed(env: Env, request: Request, secret: string, { now = Date.now(), fetch: fetchImpl }: { now?: number; fetch?: Fetch } = {}): Promise<Response> {
  const pid = await feedOwner(env, secret);
  if (!pid) return notFound();
  const record = await loadPerson(env, pid);
  if (!record || record.feed?.secret !== secret) return notFound();
  const last = await cached(env, pid);
  const person = new Person(env, record, fetchImpl);
  try {
    const view = await person.view();
    const signal = await person.signal(view, `${record.lang}|${record.timeZone}`);
    if (last && last.signal === signal) {
      log('feed', { served: 'cached' });
      return respond(request, last.body, last.etag);
    }
    const loaded = await person.load(view);
    await loadExportLang(record.lang);
    const events = exportEvents({ ...loaded, me: record.email, role: view.role, lang: record.lang, timeZone: record.timeZone, settings: view.settings });
    const body = exportIcs(events, { householdId: record.household, timeZone: record.timeZone, lang: record.lang, now });
    const problems = icsProblems(body).length;
    const etag = `"${contentHash(body)}"`;
    await env.DB.prepare('INSERT INTO feeds (pid, signal, etag, body, built_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(pid) DO UPDATE SET signal = excluded.signal, etag = excluded.etag, body = excluded.body, built_at = excluded.built_at')
      .bind(pid, signal, etag, body, now)
      .run();
    log('feed', { served: 'built', events: events.length, problems });
    return respond(request, body, etag);
  } catch (e) {
    if (e instanceof NotMember) {
      // They left the household: the feed goes, and so does what the Worker kept for it.
      await revokeFeed(env, secret);
      await savePerson(env, pid, { ...record, feed: undefined });
      await upsertPersonRow(env, pid, { feed: 0 }, now);
      log('feed', { served: 'gone' });
      return notFound();
    }
    if (signInGone(e)) {
      await savePerson(env, pid, { ...record, signedOut: true });
      log('feed', { served: last ? 'stale' : 'none', reason: 'signed-out' });
    } else log('feed', { served: last ? 'stale' : 'none', reason: 'error' });
    // Keep the calendar as it was rather than emptying it; it updates once things work again.
    if (last) return respond(request, last.body, last.etag);
    return new Response('The calendar is not available right now. Try again later.\n', { status: 503, headers: { 'Retry-After': '600', 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

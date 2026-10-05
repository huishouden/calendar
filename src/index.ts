import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env, FanoutRpc } from './env';
import { handleApi } from './api';
import { checkPeople, type CheckTotals } from './check';
import { FEED_PATH, serveFeed } from './feed';
import { log } from './log';
import { MAX_CALLS, runCron } from './tick';
import { checkInboxes, runMailCron, type MailTotals } from './mail/check';
import { runMailWork } from './mail/work';
import { runWork, type WorkMessage, type WorkOutcome } from './work';
import { warm } from './warm';

export { Ticker } from './ticker';

warm();

/**
 * Routes: `/feed/<secret>.ics` (the stored feed), `/api/*` (the portal, and Spending's alert
 * inboxes), the cron (every minute: the calendar's checks, then the inboxes', fanned out), the queue
 * (one unit of a person's or an inbox's work per message), and `Fanout`, the entrypoint the cron and
 * the work call through the `SELF` service binding so that each check and each unit is its own
 * invocation.
 */

export class Fanout extends WorkerEntrypoint<Env> implements FanoutRpc {
  async check(pids: string[], googleEvery?: number): Promise<CheckTotals> {
    return checkPeople(this.env, pids, { googleEvery });
  }

  async work(pid: string): Promise<WorkOutcome> {
    return runWork(this.env, pid, { next: (p) => this.env.SELF!.work(p) });
  }

  async mail(ids: string[]): Promise<MailTotals> {
    return checkInboxes(this.env, ids);
  }

  async mailWork(id: string): Promise<WorkOutcome> {
    return runMailWork(this.env, id, { next: (i) => this.env.SELF!.mailWork(i) });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const feed = FEED_PATH.exec(url.pathname);
    if (feed && (request.method === 'GET' || request.method === 'HEAD')) return serveFeed(env, request, feed[1], { ctx });
    if (url.pathname.startsWith('/api/')) return handleApi(env, request, ctx);
    if (url.pathname === '/') return new Response('huishouden calendar: household calendar feeds and Google Calendar sync. Set it up in Huishouden, Settings > Calendar.\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    return new Response('Not found\n', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // The calendar's checks, then Spending's alert inboxes with the invocations they left.
    const now = controller.scheduledTime;
    ctx.waitUntil(
      runCron(env, { now })
        .catch(() => ({ calls: MAX_CALLS / 2 }))
        .then((t) => runMailCron(env, { now, calls: Math.max(1, MAX_CALLS - (t.calls ?? 0)) }))
        .then(() => undefined),
    );
  },

  /** One message, one unit (max_batch_size = 1): each has the invocation's CPU time to itself. */
  async queue(batch: MessageBatch<WorkMessage | { inbox: string }>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const body = message.body;
      const outcome = await ('inbox' in body
        ? runMailWork(env, body.inbox, { next: env.SELF ? (i) => env.SELF!.mailWork(i) : undefined })
        : runWork(env, body.pid, { next: env.SELF ? (p) => env.SELF!.work(p) : undefined })
      ).catch((): WorkOutcome => ({ retryAfter: 60, reason: 'error' }));
      if ('done' in outcome) {
        message.ack();
        continue;
      }
      // Busy (another unit holds the person), backing off from Google, or failed: again later. After
      // max_retries the message goes; the work stays marked and the cron sends it again.
      message.retry({ delaySeconds: Math.min(outcome.retryAfter, 43_200) });
      log('queue', { retry: outcome.reason, after: outcome.retryAfter });
    }
  },
} satisfies ExportedHandler<Env, WorkMessage | { inbox: string }>;

import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env, FanoutRpc } from './env';
import { handleApi } from './api';
import { checkPeople, type CheckTotals } from './check';
import { FEED_PATH, serveFeed } from './feed';
import { log } from './log';
import { runCron } from './tick';
import { runWork, type WorkMessage, type WorkOutcome } from './work';
import { warm } from './warm';

warm();

/**
 * Routes: `/feed/<secret>.ics` (the stored feed), `/api/*` (the portal), the cron (every minute:
 * the checks, fanned out), the queue (one unit of a person's work per message), and `Fanout`, the
 * entrypoint the cron and the work call through the `SELF` service binding so that each check and
 * each unit is its own invocation.
 */

export class Fanout extends WorkerEntrypoint<Env> implements FanoutRpc {
  async check(pids: string[]): Promise<CheckTotals> {
    return checkPeople(this.env, pids);
  }

  async work(pid: string): Promise<WorkOutcome> {
    return runWork(this.env, pid, { next: (p) => this.env.SELF!.work(p) });
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
    ctx.waitUntil(runCron(env, { now: controller.scheduledTime }).then(() => undefined));
  },

  /** One message, one unit (max_batch_size = 1): each has the invocation's CPU time to itself. */
  async queue(batch: MessageBatch<WorkMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const outcome = await runWork(env, message.body.pid, { next: env.SELF ? (p) => env.SELF!.work(p) : undefined }).catch((): WorkOutcome => ({ retryAfter: 60, reason: 'error' }));
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
} satisfies ExportedHandler<Env, WorkMessage>;

import type { Env } from './env';
import { handleApi } from './api';
import { FEED_PATH, serveFeed } from './feed';
import { runCron } from './sync';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const feed = FEED_PATH.exec(url.pathname);
    if (feed && (request.method === 'GET' || request.method === 'HEAD')) return serveFeed(env, request, feed[1]);
    if (url.pathname.startsWith('/api/')) return handleApi(env, request, ctx);
    if (url.pathname === '/') return new Response('huishouden calendar: household calendar feeds and Google Calendar sync. Set it up in Huishouden, Settings > Calendar.\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    return new Response('Not found\n', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env, { now: controller.scheduledTime }).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;

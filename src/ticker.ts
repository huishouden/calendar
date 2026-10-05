import { DurableObject } from 'cloudflare:workers';
import type { Env, TickerRpc } from './env';
import { log } from './log';
import { nextAlarm, runPart } from './tick';

/**
 * A Ticker: one more root for the minute's checks (src/tick.ts). The cron can start 31 invocations
 * (Cloudflare's 32 per request); when a minute has more chunks than that, the cron arms Tickers
 * 1..n-1, and each one's alarm, every minute a few seconds after the cron, checks its share (`part`)
 * with its own 31. A Ticker whose part is no longer needed lets its alarm lapse.
 *
 * SQLite-backed (the only kind on the free plan); it keeps just its part number.
 */
export class Ticker extends DurableObject<Env> implements TickerRpc {
  async arm(part: number): Promise<void> {
    await this.ctx.storage.put('part', part);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(nextAlarm(Date.now()));
  }

  async alarm(): Promise<void> {
    const part = await this.ctx.storage.get<number>('part');
    if (part === undefined) return;
    const now = Date.now();
    // The next alarm first, so a failed run doesn't end the chain; a part no longer needed lets it lapse below.
    await this.ctx.storage.setAlarm(nextAlarm(now));
    const totals = await runPart(this.env, { now, part }).catch(() => null);
    if (totals?.stop) {
      await this.ctx.storage.deleteAlarm();
      log('ticker', { part, stopped: true });
    }
  }
}

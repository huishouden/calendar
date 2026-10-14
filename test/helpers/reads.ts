import type { Fetch } from '../../src/env';
import { checkPeople } from '../../src/check';
import { runWork } from '../../src/work';
import { checkInboxes } from '../../src/mail/check';
import { runMailWork } from '../../src/mail/work';
import { FIRESTORE, type World } from './world';

/**
 * The world with every Firestore call through `fetch` (the kit's `expectReads` meter): the Fanout
 * entrypoint's checks and units, and the queue's, so a chain of units is counted whole.
 */
export function throughMeter(w: World, fetch: Fetch) {
  const env = w.env;
  const self = env.SELF!;
  env.SELF = {
    check: (pids) => checkPeople(env, pids, { fetch, now: w.clock.now }),
    work: (pid, handover) => runWork(env, pid, { fetch, now: w.clock.now, handover, next: (p, h) => env.SELF!.work(p, h) }),
    mail: (ids) => checkInboxes(env, ids, { fetch, now: w.clock.now, firestoreUrl: FIRESTORE }),
    mailWork: (id) => runMailWork(env, id, { fetch, now: w.clock.now, firestoreUrl: FIRESTORE, next: (i) => env.SELF!.mailWork(i) }),
    photo: self.photo,
  };
  return {
    /** The queue run as the consumer does, every unit through `fetch`. */
    drain: async () => {
      let n = 0;
      while (w.queue.length && n++ < 200) {
        const m = w.queue.shift()!;
        if ('inbox' in m) await env.SELF!.mailWork(m.inbox);
        else await env.SELF!.work(m.pid);
      }
    },
    restore: () => {
      env.SELF = self;
    },
  };
}

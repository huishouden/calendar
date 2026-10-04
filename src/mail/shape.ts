import { htmlToText, type MailMessage } from '@huishouden/pwa-kit/mail-core';
import type { AlertReading } from '@huishouden/pwa-kit/spending-core';
import type { Env } from '../env';

/**
 * The shape of an email the checker read, for supporting alert formats it can't read yet without
 * anyone reading the email: the subject and the lines that carry an amount or purchase wording, with
 * every word outside ALERT_WORDS masked (`X`), every number `#` and every amount `$#`. No merchant,
 * name, address or number survives; only an alert's fixed wording does ("You made a $# purchase at X
 * on your card ending in #"). The sender is its domain (and its address' local part only when that is
 * a role like "alerts" or "notifications").
 */

const ALERT_WORDS = new Set(
  `a about account activity added alert alerts all am amount an and any app approved are as at authorized available balance bank be been below by
  call can card cardmember cash charge charged charges check click complete completed confirm contact credit date debit declined deposit details did
  do does don't due email ending ends for from gold has have help here how if in info information is it it's its just limit made manage
  merchant message more must new no not notification notifications of on online or order our out over paid payment pending pm posted price
  purchase purchased purchases receipt received recent refund refunded report return review see sent settings spend spending spent statement
  status store team thank thanks that the this to total transaction transactions transfer txn unsubscribe up us usd use used using view
  visa mastercard was we were what when where which will with withdrawal you your yours et pt ct mt est edt pst pdt utc
  jan feb mar apr may jun jul aug sep sept oct nov dec january february march april june july august september october november december
  monday tuesday wednesday thursday friday saturday sunday today yesterday reasonable options option model trade trading invest investing shares
  stock stocks buy sell sold bought filled executed market dividend crypto portfolio offer offers earn rewards reward bonus back percent limited time
  sign tap open log login security code verify password device questions privacy policy terms rights reserved inc llc member fdic`.split(/\s+/),
);

const UPPER = new Set(['USD', 'ET', 'PT', 'CT', 'MT', 'EST', 'EDT', 'PST', 'PDT', 'UTC', 'ATM', 'POS', 'AM', 'PM']);

const ROLES = /^(?:alerts?|notifications?|notify|no-?reply|do-?not-?reply|donotreply\w*|info|service|support|news|hello|team|mail|account|accounts|cards?|security|updates?|statements?)$/i;

/** One line with everything outside the alert vocabulary masked. */
export function maskLine(line: string): string {
  const out: string[] = [];
  for (const raw of line.split(/\s+/)) {
    if (!raw) continue;
    let t: string;
    if (/\$\s?\d|^\d[\d,]*\.\d{2}$/.test(raw)) t = raw.replace(/\$?\s?\d[\d,]*(?:\.\d+)?/g, '$#').replace(/[^$#.,:;()]/g, '');
    else if (/\d/.test(raw)) t = raw.replace(/[A-Za-z]+/g, 'X').replace(/\d+/g, '#');
    else {
      const m = raw.match(/^([^A-Za-z']*)([A-Za-z'’]+)([^A-Za-z']*)$/);
      // All capitals is how alerts write a merchant ("EXAMPLE STORE"): masked even when it's a common word.
      const caps = !!m && m[2].length > 1 && m[2] === m[2].toUpperCase() && !UPPER.has(m[2]);
      if (m && !caps && ALERT_WORDS.has(m[2].toLowerCase().replace('’', "'"))) t = raw;
      else t = m ? `${m[1].replace(/[^.,:;()*#&-]/g, '')}X${m[3].replace(/[^.,:;()*#&-]/g, '')}` : 'X';
    }
    // Runs of masked words read as one.
    if (t === 'X' && out[out.length - 1] === 'X') continue;
    out.push(t);
  }
  return out.join(' ').slice(0, 160);
}

export function maskSender(from: string): string {
  const address = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 0) return 'X';
  const local = address.slice(0, at);
  return `${ROLES.test(local) ? local : 'X'}@${address.slice(at + 1).replace(/[^a-z0-9.-]/g, '')}`.slice(0, 80);
}

const SIGNAL = /\$\s?\d|\d\.\d{2}\s*USD|\b(?:purchase|transaction|charge|spent|merchant|refund|card|amount|order|deposit|date)\b/i;

/** The lines worth seeing: an amount or purchase wording, masked, at most 15. */
export function shapeLines(msg: MailMessage): string[] {
  const body = msg.text ?? (msg.html ? htmlToText(msg.html) : '');
  return body
    .split('\n')
    .filter((l) => SIGNAL.test(l))
    .slice(0, 15)
    .map(maskLine);
}

export const outcomeOf = (r: AlertReading): string => (r.kind === 'purchase' ? `purchase:${r.rule}` : `${r.kind}:${r.reason}`);

export const SHAPES_KEEP_MS = 14 * 86_400_000;

export function recordShape(env: Env, inbox: string, msg: MailMessage, reading: AlertReading, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO mail_shapes (inbox, msg, at, sender, subject, bulk, lines, outcome) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(inbox, msg) DO UPDATE SET at = excluded.at, sender = excluded.sender, subject = excluded.subject, bulk = excluded.bulk, lines = excluded.lines, outcome = excluded.outcome`,
  ).bind(inbox, msg.id, now, maskSender(msg.from), maskLine(msg.subject), msg.bulk ? 1 : 0, JSON.stringify(shapeLines(msg)), outcomeOf(reading));
}

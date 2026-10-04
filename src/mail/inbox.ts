import { FieldDelete, FirestoreError } from '@huishouden/pwa-kit/firestore-rest';
import { ALERT_INBOXES, alertQuery, DEFAULT_RULES, type AlertCard, type CategoryRule } from '@huishouden/pwa-kit/spending-core';
import type { Env, Fetch } from '../env';
import { Person } from '../person';
import type { InboxConfig, InboxRecord } from './store';

/**
 * The household side of an alert inbox, read and written as the member who connected it, so the
 * household's rules decide: the cards, labels and category rules the search and the parser use, and
 * the inbox's document (`spendingInboxes/{id}`) with what the checker last found.
 */

/** How far before `since` a search looks: mail Gmail files late (delayed delivery) is still found; the seen list skips what was read. */
export const SEARCH_MARGIN_MS = 24 * 3_600_000;

/** The Gmail search for alerts after `since`, or null when the household has nothing to search for. */
export const searchFor = (config: InboxConfig, since: number): string | null => alertQuery(config.cards, config.labels, { after: Math.max(0, since - SEARCH_MARGIN_MS) });

export const actingAs = (env: Env, record: InboxRecord, fetchImpl?: Fetch, firestoreUrl?: string) => new Person(env, { household: record.household, email: record.email, refreshToken: record.refreshToken }, fetchImpl, firestoreUrl);

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The household's cards, labels and rules (DEFAULT_RULES until the household saved its own, as the app does). */
export async function readConfig(person: Person): Promise<InboxConfig> {
  const [cards, rules, settings] = await Promise.all([
    person.db.query(person.base, 'spendingCards'),
    person.db.query(person.base, 'spendingRules'),
    person.db.get(`${person.base}/spendingSettings/main`),
  ]);
  const alertCards: AlertCard[] = cards.map((d) => ({ name: str(d.data.name), ...(d.data.last4 ? { last4: str(d.data.last4) } : {}), alertWords: strList(d.data.alertWords) }));
  const ruleList: CategoryRule[] = settings ? rules.map((d) => ({ contains: str(d.data.contains), category: str(d.data.category) })) : DEFAULT_RULES;
  return { cards: alertCards, labels: strList(settings?.data.alertLabels), rules: ruleList };
}

/** The inbox's document as the member writes it on connecting. */
export function inboxDoc(record: InboxRecord, now: number) {
  return { address: record.address.slice(0, 200), connectedAt: record.connectedAt, updatedAt: now, by: record.email };
}

/**
 * The checker's state on the inbox's document, merged in the member's name: alerts found, or an
 * error (null clears it). Returns false when the document is gone (someone disconnected it).
 */
export async function reportInbox(person: Person, id: string, fields: { lastAlertAt?: number; lastAdded?: number; error?: string | null }, now: number): Promise<boolean> {
  const path = `${person.base}/${ALERT_INBOXES}/${id}`;
  const current = await person.db.get(path);
  if (!current) return false;
  if (fields.error !== undefined && (current.data.error ?? null) === fields.error && fields.lastAlertAt === undefined) return true;
  const data: Record<string, unknown> = { updatedAt: now, by: person.record.email };
  if (fields.lastAlertAt !== undefined) data.lastAlertAt = fields.lastAlertAt;
  if (fields.lastAdded !== undefined) data.lastAdded = Math.min(1000, fields.lastAdded);
  if (fields.error !== undefined) data.error = fields.error === null ? new FieldDelete() : fields.error.slice(0, 40);
  await person.db.commit([{ path, merge: data }]);
  return true;
}

/** Firestore refused the member: they left the household, or their role no longer reads Spending. */
export const refused = (e: unknown): boolean => e instanceof FirestoreError && e.code === 'permission-denied';

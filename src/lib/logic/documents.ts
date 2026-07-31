import type { DayKey } from "@/lib/date";
import { DOCUMENT_KIND_META, type DocumentKind } from "@/lib/enums";
import { dueBucketOf, daysUntil, type DueBucket } from "@/lib/logic/due";

/**
 * Documents & renewals — pure. The server fetches rows; everything that turns
 * an expiry date into "how urgent is this, and will it remind me" lives here,
 * so the inbox page, the dashboard, the reminder feed and the tests share one
 * set of answers.
 *
 * The model is deliberately small (see `LifeDocument` in the schema): a name,
 * a kind, a date it runs out on, and how far ahead to warn. Renewing is an
 * edit — move the date forward and the reminder re-arms on its own, exactly
 * how a bill behaves when it is paid.
 */

/** How far ahead a document reads as "renew this soon" on the surfaces. */
export const DOCUMENT_SOON_DAYS = 30;

export interface DocumentLike {
  id: string;
  name: string;
  kind: string;
  expiryDate: DayKey;
  reminderEnabled: boolean;
  reminderDaysBefore: number;
  archivedAt: Date | string | null;
}

export function documentIsActive(document: Pick<DocumentLike, "archivedAt">): boolean {
  return document.archivedAt === null;
}

export function documentKindLabel(kind: string): string {
  return DOCUMENT_KIND_META[kind as DocumentKind]?.label ?? kind;
}

/**
 * "Expires today", "Expired 3 days ago", "Expires in 5 days" — the same
 * arithmetic as `describeDueDistance`, worded for something that runs out
 * rather than something that is owed.
 */
export function describeExpiryDistance(expiryDate: DayKey, today: DayKey): string {
  const distance = daysUntil(expiryDate, today);
  if (distance === 0) return "Expires today";
  if (distance === 1) return "Expires tomorrow";
  if (distance === -1) return "Expired yesterday";
  if (distance < 0) return `Expired ${-distance} days ago`;
  return `Expires in ${distance} days`;
}

export interface DocumentView<D extends DocumentLike = DocumentLike> {
  document: D;
  bucket: DueBucket;
  /** Signed days to the expiry date: negative = already expired. */
  daysUntilExpiry: number;
  expired: boolean;
  /**
   * True when today falls inside the document's own reminder window — the day
   * itself, or the `reminderDaysBefore` run-up. This is what the UI badges as
   * "reminder armed"; whether it has actually *fired* is the delivery ledger's
   * business, not a rendering concern.
   */
  reminderArmed: boolean;
}

/**
 * Active documents annotated with their expiry state, most urgent first.
 * `soonDays` widens the "soon" bucket — the surfaces look a month out, which
 * is also the default reminder lead time.
 */
export function documentsByExpiry<D extends DocumentLike>(
  documents: D[],
  today: DayKey,
  soonDays: number = DOCUMENT_SOON_DAYS,
): DocumentView<D>[] {
  return documents
    .filter(documentIsActive)
    .map((document) => {
      const daysUntilExpiry = daysUntil(document.expiryDate, today);
      return {
        document,
        bucket: dueBucketOf(document.expiryDate, today, soonDays),
        daysUntilExpiry,
        expired: daysUntilExpiry < 0,
        reminderArmed:
          document.reminderEnabled &&
          daysUntilExpiry >= 0 &&
          daysUntilExpiry <= Math.max(0, document.reminderDaysBefore),
      };
    })
    .sort(
      (a, b) =>
        a.daysUntilExpiry - b.daysUntilExpiry ||
        a.document.name.localeCompare(b.document.name),
    );
}

/** Documents expiring within `withinDays` (already-expired ones included). */
export function documentsExpiringSoon<D extends DocumentLike>(
  views: DocumentView<D>[],
  withinDays: number = DOCUMENT_SOON_DAYS,
): DocumentView<D>[] {
  return views.filter((view) => view.daysUntilExpiry <= withinDays);
}

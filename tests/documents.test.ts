import { describe, expect, it } from "vitest";

import {
  DOCUMENT_SOON_DAYS,
  documentIsActive,
  documentKindLabel,
  documentsByExpiry,
  documentsExpiringSoon,
  type DocumentLike,
} from "@/lib/logic/documents";

const TODAY = "2026-07-31";

function doc(partial: Partial<DocumentLike> = {}): DocumentLike {
  return {
    id: "d1",
    name: "Passport",
    kind: "id",
    expiryDate: "2026-12-31",
    reminderEnabled: true,
    reminderDaysBefore: 30,
    archivedAt: null,
    ...partial,
  };
}

describe("document expiry views", () => {
  it("annotates each document with its distance and bucket", () => {
    const [view] = documentsByExpiry([doc({ expiryDate: "2026-08-10" })], TODAY);
    expect(view.daysUntilExpiry).toBe(10);
    expect(view.bucket).toBe("soon");
    expect(view.expired).toBe(false);
  });

  it("expiring today is 'today', already expired is negative and overdue", () => {
    const [today] = documentsByExpiry([doc({ expiryDate: TODAY })], TODAY);
    expect(today).toMatchObject({ daysUntilExpiry: 0, bucket: "today", expired: false });

    const [gone] = documentsByExpiry([doc({ expiryDate: "2026-07-01" })], TODAY);
    expect(gone).toMatchObject({ daysUntilExpiry: -30, bucket: "overdue", expired: true });
  });

  it("sorts most urgent first, expired ahead of everything", () => {
    const views = documentsByExpiry(
      [
        doc({ id: "later", name: "Passport", expiryDate: "2027-01-01" }),
        doc({ id: "soon", name: "Lease", expiryDate: "2026-08-05" }),
        doc({ id: "gone", name: "Warranty", expiryDate: "2026-06-01" }),
      ],
      TODAY,
    );
    expect(views.map((view) => view.document.id)).toEqual(["gone", "soon", "later"]);
  });

  it("breaks ties by name so the order is stable", () => {
    const views = documentsByExpiry(
      [
        doc({ id: "b", name: "Zeta policy", expiryDate: "2026-08-05" }),
        doc({ id: "a", name: "Alpha policy", expiryDate: "2026-08-05" }),
      ],
      TODAY,
    );
    expect(views.map((view) => view.document.id)).toEqual(["a", "b"]);
  });

  it("archived documents are left out entirely", () => {
    expect(documentsByExpiry([doc({ archivedAt: new Date() })], TODAY)).toEqual([]);
    expect(documentIsActive(doc({ archivedAt: null }))).toBe(true);
    expect(documentIsActive(doc({ archivedAt: new Date() }))).toBe(false);
  });
});

describe("reminder-armed state", () => {
  it("is armed inside its own run-up window, and on the day", () => {
    const [inWindow] = documentsByExpiry(
      [doc({ expiryDate: "2026-08-20", reminderDaysBefore: 30 })],
      TODAY,
    );
    expect(inWindow.reminderArmed).toBe(true);

    const [onDay] = documentsByExpiry([doc({ expiryDate: TODAY })], TODAY);
    expect(onDay.reminderArmed).toBe(true);
  });

  it("is not armed before the window opens", () => {
    const [view] = documentsByExpiry(
      [doc({ expiryDate: "2026-10-01", reminderDaysBefore: 30 })],
      TODAY,
    );
    expect(view.reminderArmed).toBe(false);
  });

  it("is not armed once expired — the row shows that state instead", () => {
    const [view] = documentsByExpiry([doc({ expiryDate: "2026-07-30" })], TODAY);
    expect(view.reminderArmed).toBe(false);
    expect(view.expired).toBe(true);
  });

  it("is never armed when the reminder is switched off", () => {
    const [view] = documentsByExpiry(
      [doc({ expiryDate: "2026-08-05", reminderEnabled: false })],
      TODAY,
    );
    expect(view.reminderArmed).toBe(false);
  });

  it("a zero lead time arms only on the day itself", () => {
    const [before] = documentsByExpiry(
      [doc({ expiryDate: "2026-08-01", reminderDaysBefore: 0 })],
      TODAY,
    );
    expect(before.reminderArmed).toBe(false);

    const [onDay] = documentsByExpiry([doc({ expiryDate: TODAY, reminderDaysBefore: 0 })], TODAY);
    expect(onDay.reminderArmed).toBe(true);
  });
});

describe("expiring-soon slice", () => {
  it("takes everything inside the window, expired included", () => {
    const views = documentsByExpiry(
      [
        doc({ id: "gone", expiryDate: "2026-07-01" }),
        doc({ id: "soon", expiryDate: "2026-08-15" }),
        doc({ id: "later", expiryDate: "2027-01-01" }),
      ],
      TODAY,
    );
    expect(documentsExpiringSoon(views).map((view) => view.document.id)).toEqual(["gone", "soon"]);
    expect(documentsExpiringSoon(views, 7).map((view) => view.document.id)).toEqual(["gone"]);
    expect(DOCUMENT_SOON_DAYS).toBe(30);
  });
});

describe("kind labels", () => {
  it("labels known kinds and passes unknown ones through untouched", () => {
    expect(documentKindLabel("insurance")).toBe("Insurance");
    expect(documentKindLabel("lease")).toBe("Lease & housing");
    expect(documentKindLabel("something-else")).toBe("something-else");
  });
});

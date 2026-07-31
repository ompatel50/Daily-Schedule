import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BACKUP_TABLES,
  BACKUP_VERSION,
  checksumOf,
  inspectBackup,
} from "@/lib/backup-format";

function backup(overrides: Record<string, unknown> = {}) {
  return {
    app: "personal-os",
    version: BACKUP_VERSION,
    exportedAt: "2026-03-04T12:00:00.000Z",
    data: { habits: [{ id: "h1" }], scheduleRules: [{ id: "r1" }] },
    ...overrides,
  };
}

describe("backup validation", () => {
  it("accepts a well-formed backup and counts its rows", () => {
    const result = inspectBackup(backup());
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.counts.habits).toBe(1);
    expect(result.counts.scheduleRules).toBe(1);
    expect(result.total).toBe(2);
  });

  it("rejects a file that is not a Personal OS backup", () => {
    expect(inspectBackup({ app: "something-else", version: 1, data: {} }).ok).toBe(false);
    expect(inspectBackup("not json at all").ok).toBe(false);
    expect(inspectBackup(null).ok).toBe(false);
  });

  it("refuses a newer format rather than importing it partially", () => {
    const result = inspectBackup(backup({ version: BACKUP_VERSION + 1 }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("newer version");
  });

  it("rejects a file with no data section", () => {
    const result = inspectBackup({ app: "personal-os", version: BACKUP_VERSION });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no data");
  });

  it("accepts an older format with a warning about what will happen", () => {
    const result = inspectBackup(backup({ version: 1 }));
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("every-day schedule");
  });

  it("v5 carries the finance-workflow tables and counts their rows", () => {
    expect(BACKUP_TABLES).toContain("budgets");
    expect(BACKUP_TABLES).toContain("financeImportBatches");
    // Restore order: tasks precede the schedule items that may link to them,
    // and import batches precede the transactions that may link to THEM.
    expect(BACKUP_TABLES.indexOf("tasks")).toBeLessThan(BACKUP_TABLES.indexOf("scheduleItems"));
    expect(BACKUP_TABLES.indexOf("financeImportBatches")).toBeLessThan(
      BACKUP_TABLES.indexOf("financeTransactions"),
    );

    const result = inspectBackup(
      backup({ data: { budgets: [{ id: "b1" }], financeImportBatches: [{ id: "i1" }] } }),
    );
    expect(result.ok).toBe(true);
    expect(result.counts.budgets).toBe(1);
    expect(result.counts.financeImportBatches).toBe(1);
    expect(result.warnings.join(" ")).not.toContain("unrecognised");
  });

  it("v6 carries documents and task tags, in an order the links survive", () => {
    expect(BACKUP_TABLES).toContain("documents");
    expect(BACKUP_TABLES).toContain("taskTags");
    // A tag join needs BOTH ends already restored.
    expect(BACKUP_TABLES.indexOf("tags")).toBeLessThan(BACKUP_TABLES.indexOf("taskTags"));
    expect(BACKUP_TABLES.indexOf("tasks")).toBeLessThan(BACKUP_TABLES.indexOf("taskTags"));

    const result = inspectBackup(
      backup({
        data: {
          documents: [{ id: "d1" }, { id: "d2" }],
          taskTags: [{ taskId: "t1", tagId: "g1" }],
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.counts.documents).toBe(2);
    expect(result.counts.taskTags).toBe(1);
    expect(result.warnings.join(" ")).not.toContain("unrecognised");
  });

  it("v7 carries health records, after the batches they belong to", () => {
    expect(BACKUP_TABLES).toContain("healthRecords");
    // A record's batch link only survives if the batch was restored first.
    expect(BACKUP_TABLES.indexOf("healthImportBatches")).toBeLessThan(
      BACKUP_TABLES.indexOf("healthRecords"),
    );

    const result = inspectBackup(
      backup({
        version: 7,
        data: {
          healthImportBatches: [{ id: "hb1" }],
          healthRecords: [{ id: "hr1" }, { id: "hr2" }],
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.counts.healthRecords).toBe(2);
    expect(result.warnings.join(" ")).not.toContain("unrecognised");
  });

  it("v8 adds no tables — only columns on the health import batch", () => {
    // The bump exists so an older app refuses a newer file rather than
    // silently dropping `protectedRows` and `formatVersion` on restore. No
    // table moved, so nothing about restore ORDER changed with it.
    expect(BACKUP_VERSION).toBe(8);
    expect(BACKUP_TABLES.indexOf("healthImportBatches")).toBeLessThan(
      BACKUP_TABLES.indexOf("healthMetrics"),
    );
  });

  it("a v7 file (no smart-merge accounting) still inspects cleanly", () => {
    const result = inspectBackup(
      backup({
        version: 7,
        data: { healthImportBatches: [{ id: "hb1" }], healthRecords: [{ id: "hr1" }] },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.counts.healthRecords).toBe(1);
    expect(result.warnings.join(" ")).toContain("format v7");
  });

  it("a v6 file (no health records) still inspects cleanly", () => {
    const result = inspectBackup(
      backup({ version: 6, data: { documents: [{ id: "d1" }], healthMetrics: [{ id: "m1" }] } }),
    );
    expect(result.ok).toBe(true);
    expect(result.counts.healthRecords).toBe(0);
    expect(result.warnings.join(" ")).toContain("format v6");
  });

  it("a v5 file (no documents, no task tags) still inspects cleanly", () => {
    const result = inspectBackup(
      backup({ version: 5, data: { budgets: [{ id: "b1" }], tasks: [{ id: "t1" }] } }),
    );
    expect(result.ok).toBe(true);
    expect(result.counts.documents).toBe(0);
    expect(result.counts.taskTags).toBe(0);
    expect(result.warnings.join(" ")).toContain("format v5");
  });

  it("a v4 file (no budgets, no import batches) still inspects cleanly", () => {
    const result = inspectBackup(
      backup({ version: 4, data: { financeAccounts: [{ id: "a1" }], tasks: [{ id: "t1" }] } }),
    );
    expect(result.ok).toBe(true);
    expect(result.counts.budgets).toBe(0);
    expect(result.warnings.join(" ")).toContain("format v4");
  });

  it("warns about unrecognised tables instead of failing", () => {
    const result = inspectBackup(backup({ data: { habits: [], somethingElse: [{}] } }));
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("unrecognised");
  });

  it("warns when the checksum does not match the payload", () => {
    const data = { habits: [{ id: "h1" }] };
    const good = inspectBackup(
      backup({ data, meta: { checksum: checksumOf(JSON.stringify(data)) } }),
    );
    expect(good.warnings.join(" ")).not.toContain("checksum");

    const bad = inspectBackup(backup({ data, meta: { checksum: "deadbeef" } }));
    expect(bad.warnings.join(" ")).toContain("checksum");
  });

  it("warns about an empty backup", () => {
    const result = inspectBackup(backup({ data: {} }));
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("no records");
  });
});

describe("checksum", () => {
  it("is stable and changes when the content changes", () => {
    expect(checksumOf("abc")).toBe(checksumOf("abc"));
    expect(checksumOf("abc")).not.toBe(checksumOf("abd"));
    expect(checksumOf("")).toHaveLength(8);
  });
});

describe("the backup covers every table the app writes", () => {
  const exportSource = readFileSync("src/server/actions/backup.ts", "utf8");
  const restoreSource = readFileSync("src/server/backup-restore.ts", "utf8");

  it("exports and restores each table in BACKUP_TABLES", () => {
    for (const table of BACKUP_TABLES) {
      expect(exportSource, `${table} should be exported`).toContain(`${table},`);
      expect(restoreSource, `${table} should have a restore handler`).toContain(`"${table}"`);
    }
  });

  it("includes the scheduling tables — without them a restore loses every schedule", () => {
    expect(BACKUP_TABLES).toContain("scheduleRules");
    expect(BACKUP_TABLES).toContain("scheduleRuleDays");
    expect(BACKUP_TABLES).toContain("scheduleOverrides");
    expect(BACKUP_TABLES).toContain("goalEntries");
  });

  it("clears the scheduling tables in replace mode", () => {
    // Replace mode that skipped these would leave orphaned schedules pointing at
    // deleted goals, which the engine would then resolve against. The deletes
    // run inside the restore transaction, hence `db.` rather than `prisma.`.
    expect(restoreSource).toContain("db.scheduleRule.deleteMany");
    expect(restoreSource).toContain("db.scheduleRuleDay.deleteMany");
    expect(restoreSource).toContain("db.scheduleOverride.deleteMany");
    expect(restoreSource).toContain("db.goalEntry.deleteMany");
  });

  it("wraps the restore in one transaction and rolls back on failure", () => {
    expect(restoreSource).toContain("prisma.$transaction(");
    expect(exportSource).toContain("rolled back");
  });

  it("never trusts an id from the file — every imported row is remapped", () => {
    expect(restoreSource).toContain("remapId(");
    // The one deliberate exception is shared reference data, which is reused
    // by identity and never modified.
    expect(restoreSource).toContain("keepGlobal");
  });
});

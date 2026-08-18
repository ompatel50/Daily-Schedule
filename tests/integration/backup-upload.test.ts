/**
 * The staged backup import against real PostgreSQL: the health importer's
 * transport reused under `kind: "backup"` — open/receive/preview/import round
 * trips, multi-part reassembly fidelity, the preview releasing the session
 * for the confirm, kind isolation (a health session is invisible to the
 * backup finalize and vice versa), ownership, and the size refusal.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { exportBackup } from "@/server/actions/backup";
import {
  BACKUP_MAX_UPLOAD_BYTES,
  finalizeBackupUpload,
  openBackupUpload,
  receiveBackupPart,
} from "@/server/backup-upload";
import { openUpload } from "@/server/health-upload/session";
import { actAs, resetDatabase, twoUsers, type User } from "./helpers";

let alice: User;
let bob: User;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();

/** Slice `content` into the session's parts and PUT each one. */
async function uploadInParts(
  userId: string,
  content: Uint8Array,
  fileName = "backup.json",
): Promise<{ uploadId: string; totalParts: number }> {
  const opened = await openBackupUpload(userId, { fileName, fileSize: content.byteLength });
  if (!opened.ok) throw new Error(opened.error);
  const { uploadId, partBytes, totalParts } = opened.data;
  for (let seq = 0; seq < totalParts; seq += 1) {
    const slice = content.slice(seq * partBytes, Math.min(content.byteLength, (seq + 1) * partBytes));
    const received = await receiveBackupPart(userId, { uploadId, seq, body: streamOf(slice) });
    if (!received.ok) throw new Error(received.error);
  }
  return { uploadId, totalParts };
}

describe("the staged backup round trip", () => {
  it("previews without writing, keeps the parts, then imports on confirm", async () => {
    await prisma.task.create({ data: { userId: alice.id, title: "Hers to carry" } });
    const exported = await exportBackup();
    if (!exported.ok) throw new Error("export failed");
    const bytes = new TextEncoder().encode(JSON.stringify(exported.data));

    // Bob stages alice's file into HIS account — the classic migration.
    actAs(bob);
    const { uploadId } = await uploadInParts(bob.id, bytes);

    const preview = await finalizeBackupUpload(bob.id, uploadId, { action: "preview" });
    expect(preview.ok).toBe(true);
    if (!preview.ok || preview.data.action !== "preview") return;
    expect(preview.data.inspection.ok).toBe(true);
    // Nothing written by a preview.
    expect(await prisma.task.count({ where: { userId: bob.id } })).toBe(0);
    // The session survived the preview — that is what the confirm needs.
    expect(
      await prisma.healthUploadSession.count({ where: { id: uploadId, status: "receiving" } }),
    ).toBe(1);

    const imported = await finalizeBackupUpload(bob.id, uploadId, {
      action: "import",
      mode: "merge",
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok || imported.data.action !== "import") return;
    expect(imported.data.report.ok).toBe(true);
    expect(
      await prisma.task.count({ where: { userId: bob.id, title: "Hers to carry" } }),
    ).toBe(1);
    // The import consumed the session and its parts.
    expect(await prisma.healthUploadSession.count({ where: { id: uploadId } })).toBe(0);
  });

  it("reassembles a multi-part upload byte-for-byte", async () => {
    const exported = await exportBackup();
    if (!exported.ok) throw new Error("export failed");
    // Pad an ignored key so the JSON spans several 4 MB parts; the restore
    // only ever reads the tables it knows.
    const padded = {
      ...exported.data,
      data: { ...exported.data.data, _padding: ["x".repeat(9 * 1024 * 1024)] },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(padded));
    const { uploadId, totalParts } = await uploadInParts(alice.id, bytes);
    expect(totalParts).toBeGreaterThan(1);

    const preview = await finalizeBackupUpload(alice.id, uploadId, { action: "preview" });
    expect(preview.ok).toBe(true);
    if (preview.ok && preview.data.action === "preview") {
      expect(preview.data.inspection.ok).toBe(true);
    }
  });

  it("a file that is not JSON is refused and the parts are freed", async () => {
    const { uploadId } = await uploadInParts(alice.id, new TextEncoder().encode("not json {"));
    const preview = await finalizeBackupUpload(alice.id, uploadId, { action: "preview" });
    expect(preview.ok).toBe(false);
    expect(await prisma.healthUploadSession.count({ where: { id: uploadId } })).toBe(0);
  });
});

describe("bounds and isolation", () => {
  it("an oversized declaration is refused in one round trip", async () => {
    const refused = await openBackupUpload(alice.id, {
      fileName: "huge.json",
      fileSize: BACKUP_MAX_UPLOAD_BYTES + 1,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.status).toBe(413);
  });

  it("a health session does not exist to the backup finalize", async () => {
    const health = await openUpload(alice.id, { fileName: "export.zip", fileSize: 10 });
    if (!health.ok) throw new Error("health open failed");
    await receiveBackupPart(alice.id, {
      uploadId: health.data.uploadId,
      seq: 0,
      body: streamOf(new TextEncoder().encode("0123456789")),
    });
    const result = await finalizeBackupUpload(alice.id, health.data.uploadId, {
      action: "preview",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("another account's session id does not exist", async () => {
    const exported = await exportBackup();
    if (!exported.ok) throw new Error("export failed");
    const bytes = new TextEncoder().encode(JSON.stringify(exported.data));
    const { uploadId } = await uploadInParts(alice.id, bytes);

    const foreignPart = await receiveBackupPart(bob.id, {
      uploadId,
      seq: 0,
      body: streamOf(bytes.slice(0, 10)),
    });
    expect(foreignPart.ok).toBe(false);

    actAs(bob);
    const foreignFinalize = await finalizeBackupUpload(bob.id, uploadId, { action: "preview" });
    expect(foreignFinalize.ok).toBe(false);
    if (!foreignFinalize.ok) expect(foreignFinalize.status).toBe(404);
  });
});

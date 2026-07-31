/**
 * The staged health-import upload, against real PostgreSQL.
 *
 * This is the transport layer that replaced a single large POST. The old flow
 * sent the whole Apple Health `export.zip` as one request body, which a hosting
 * platform refuses at the edge (`413 FUNCTION_PAYLOAD_TOO_LARGE`) before any of
 * this app's code runs — so on the hosted deployment the importer could not
 * import the one file it exists for.
 *
 * What is asserted here is the whole replacement path, end to end and in the
 * order the routes call it: open → parts → assemble → parse → preview →
 * confirm → re-import → undo, plus every bound and every ownership rule that
 * has to hold along the way. Nothing here is mocked except the session; the
 * parts really are stored, really are reassembled, and the archive really is
 * parsed by the same parser the old path used.
 *
 * All data is synthetic and nothing here talks to a network.
 */
import { readFile, rm } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { AppleImportError } from "@/server/apple-health/parse-archive";
import { parseUploadedFile } from "@/server/apple-health/parse-upload";
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_PART_BYTES,
  VERCEL_REQUEST_BODY_BYTES,
} from "@/server/apple-health/limits";
import {
  MAX_ACTIVE_UPLOADS,
  UPLOAD_TTL_MS,
  UPLOAD_UNSTARTED_MS,
  assembleUpload,
  discardUpload,
  openUpload,
  receivePart,
  sweepExpiredUploads,
} from "@/server/health-upload/session";
import {
  confirmHealthImport,
  listImportBatches,
  removeImportBatch,
  stageImport,
} from "@/server/health-import";
import { actAs, resetDatabase, twoUsers } from "./helpers";
import { APPLE_EXPORT_XML_RICH, VALID_CSV } from "../fixtures/apple-health";

import type { User } from "./helpers";

let alice: User;
let bob: User;
const scratch: string[] = [];

// --- a hand-built archive, so the suite needs no external zipper -------------

interface Member {
  name: string;
  content: Buffer;
  /** Stored (method 0) rather than deflated — used to make a bulky archive. */
  stored?: boolean;
}

function buildZip(members: Member[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, "utf8");
    const raw = member.content;
    const data = member.stored ? raw : deflateRawSync(raw);
    const method = member.stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(0x800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuffer, eocd]);
}

const smallArchive = () =>
  buildZip([{ name: "apple_health_export/export.xml", content: Buffer.from(APPLE_EXPORT_XML_RICH) }]);

/**
 * An archive big enough to need several parts.
 *
 * The bulk is a *stored* member of deterministic pseudo-random bytes: stored so
 * it cannot be compressed away, pseudo-random from a fixed seed so the test is
 * byte-for-byte reproducible, and named so the parser ignores it without ever
 * reading it. The point is the transport, not the payload.
 */
function bulkyArchive(padBytes: number): Buffer {
  const pad = Buffer.alloc(padBytes);
  let seed = 0x2545f491;
  for (let index = 0; index < padBytes; index += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    pad[index] = seed >>> 24;
  }
  return buildZip([
    { name: "apple_health_export/export.xml", content: Buffer.from(APPLE_EXPORT_XML_RICH) },
    { name: "apple_health_export/padding.bin", content: pad, stored: true },
  ]);
}

// --- the route flow, as the routes actually perform it ----------------------

/** Feed one part exactly as `PUT /api/health/import/part` does. */
function putPart(user: User, uploadId: string, seq: number, bytes: Buffer) {
  return receivePart(user.id, {
    uploadId,
    seq: String(seq),
    body: new Blob([new Uint8Array(bytes)]).stream(),
  });
}

/** Open a session and send every part of `archive`. Returns the upload id. */
async function uploadInParts(user: User, archive: Buffer, fileName = "export.zip") {
  const opened = await openUpload(user.id, { fileName, fileSize: archive.length });
  if (!opened.ok) throw new Error(`openUpload refused: ${opened.error}`);
  const { uploadId, partBytes, totalParts } = opened.data;

  for (let seq = 0; seq < totalParts; seq += 1) {
    const slice = archive.subarray(seq * partBytes, Math.min((seq + 1) * partBytes, archive.length));
    const stored = await putPart(user, uploadId, seq, slice);
    if (!stored.ok) throw new Error(`part ${seq} refused: ${stored.error}`);
  }
  return { uploadId, partBytes, totalParts };
}

/**
 * The whole of what `POST /api/health/import/finalize` does, including its
 * cleanup — so a test that stages through this leaves the database in exactly
 * the state the route leaves it in.
 */
async function finalize(user: User, uploadId: string) {
  const assembled = await assembleUpload(user.id, uploadId);
  if (!assembled.ok) return { ok: false as const, error: assembled.error, status: assembled.status };
  scratch.push(assembled.data.directory);
  try {
    const parsed = await parseUploadedFile(assembled.data.path, assembled.data.fileName);
    const staged = await stageImport(user.id, {
      kind: parsed.plan.kind,
      fileType: parsed.fileType,
      fileName: assembled.data.fileName,
      fileSize: assembled.data.bytes,
      plan: parsed.plan,
      parseMs: 1,
      xmlBytes: parsed.xmlBytes,
      ignoredFiles: parsed.ignoredFiles,
      errors: parsed.errors,
    });
    if (!staged.ok) return { ok: false as const, error: staged.error, status: 400 };
    return { ok: true as const, preview: staged.preview, bytes: assembled.data.bytes };
  } catch (error) {
    // Exactly what the route does: a refusal the parser meant is a 400 the
    // user can read, not a 500.
    if (error instanceof AppleImportError) {
      return { ok: false as const, error: error.message, status: 400 };
    }
    throw error;
  } finally {
    await rm(assembled.data.directory, { recursive: true, force: true }).catch(() => {});
    await discardUpload(user.id, uploadId);
  }
}

/** Pick a file and get a preview, the way the browser does. */
async function stageThroughUpload(user: User, archive: Buffer, fileName = "export.zip") {
  const { uploadId } = await uploadInParts(user, archive, fileName);
  return finalize(user, uploadId);
}

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

// ---------------------------------------------------------------------------

describe("a staged upload", () => {
  it("stages an archive that arrived in parts, and previews it", async () => {
    const archive = smallArchive();
    const result = await stageThroughUpload(alice, archive);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.fileName).toBe("export.zip");
    // The size recorded is what the server counted, not what a client claimed.
    expect(result.bytes).toBe(archive.length);
    expect(result.preview.fileSize).toBe(archive.length);
    expect(result.preview.categories.length).toBeGreaterThan(0);
  });

  it("produces exactly the preview the file would have produced in one piece", async () => {
    // The property that matters most: changing how the bytes travel must change
    // nothing about what is parsed out of them.
    const archive = smallArchive();
    const { uploadId } = await uploadInParts(alice, archive);
    const assembled = await assembleUpload(alice.id, uploadId);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    scratch.push(assembled.data.directory);

    const reassembled = await readFile(assembled.data.path);
    expect(reassembled.equals(archive)).toBe(true);
    await discardUpload(alice.id, uploadId);
  });

  it("carries an archive far larger than a single request may, in bounded parts", async () => {
    // 9 MB: twice the platform's whole-request cap, so the old one-shot upload
    // would have been refused at the edge. Here it is simply three requests.
    const archive = bulkyArchive(9 * 1024 * 1024);
    expect(archive.length).toBeGreaterThan(VERCEL_REQUEST_BODY_BYTES * 2);

    const { uploadId, partBytes, totalParts } = await uploadInParts(alice, archive);
    expect(totalParts).toBeGreaterThan(2);
    expect(partBytes).toBe(UPLOAD_PART_BYTES);

    // No stored part — and therefore no request that produced one — exceeds
    // what a hosting platform will accept.
    const parts = await prisma.healthUploadPart.findMany({
      where: { sessionId: uploadId },
      select: { size: true },
    });
    expect(parts).toHaveLength(totalParts);
    for (const part of parts) expect(part.size).toBeLessThanOrEqual(VERCEL_REQUEST_BODY_BYTES);

    const result = await finalize(alice, uploadId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes).toBe(archive.length);
    expect(result.preview.categories.length).toBeGreaterThan(0);
  }, 60_000);

  it("stages a CSV through the same path", async () => {
    const csv = Buffer.from(VALID_CSV);
    const result = await stageThroughUpload(alice, csv, "readings.csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.fileType).toBe("csv");
  });

  it("keeps only the base name of the uploaded file", async () => {
    const result = await stageThroughUpload(alice, smallArchive(), "/Users/someone/Desktop/export.zip");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.fileName).toBe("export.zip");
  });
});

describe("bounds", () => {
  it("refuses a declared size above what the deployment can stage", async () => {
    const opened = await openUpload(alice.id, {
      fileName: "huge.zip",
      fileSize: MAX_UPLOAD_BYTES + 1,
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.status).toBe(413);
    // Refused in one round trip — nothing was stored to find out.
    expect(await prisma.healthUploadSession.count()).toBe(0);
  });

  it("refuses a size the storage columns could not hold, rather than crashing on it", async () => {
    // The size columns are Postgres INTEGER, whose maximum is one byte below
    // the app's round 2 GB ceiling. Without the guard, a file declared as
    // exactly 2 GiB passes the limit check and then fails the insert — a 500
    // where the honest answer is the same refusal any oversized file gets.
    const opened = await openUpload(alice.id, { fileName: "huge.zip", fileSize: MAX_UPLOAD_BYTES });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.status).toBe(413);
    expect(await prisma.healthUploadSession.count()).toBe(0);

    // One byte under is still accepted by the check — the guard bounds the
    // column, it does not quietly shrink what the app accepts.
    const fits = await openUpload(alice.id, {
      fileName: "large.zip",
      fileSize: MAX_UPLOAD_BYTES - 1,
    });
    expect(fits.ok).toBe(true);
  });

  it("refuses an empty file before a session exists", async () => {
    for (const fileSize of [0, -1, 1.5, "big", null]) {
      const opened = await openUpload(alice.id, { fileName: "x.zip", fileSize });
      expect(opened.ok, String(fileSize)).toBe(false);
    }
    expect(await prisma.healthUploadSession.count()).toBe(0);
  });

  it("refuses a part index outside the session's range", async () => {
    const opened = await openUpload(alice.id, { fileName: "export.zip", fileSize: 100 });
    if (!opened.ok) throw new Error(opened.error);

    for (const seq of [-1, 1, 99, "nine"]) {
      const stored = await receivePart(alice.id, {
        uploadId: opened.data.uploadId,
        seq,
        body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
      });
      expect(stored.ok, String(seq)).toBe(false);
    }
    // The bound that makes total stored bytes structural: only indices the
    // session declared can ever hold data.
    expect(await prisma.healthUploadPart.count()).toBe(0);
  });

  it("refuses a part larger than the session's part size", async () => {
    const opened = await openUpload(alice.id, { fileName: "export.zip", fileSize: 100 });
    if (!opened.ok) throw new Error(opened.error);

    const oversized = Buffer.alloc(opened.data.partBytes + 1);
    const stored = await receivePart(alice.id, {
      uploadId: opened.data.uploadId,
      seq: 0,
      body: new Blob([new Uint8Array(oversized)]).stream(),
    });
    expect(stored.ok).toBe(false);
    if (stored.ok) return;
    expect(stored.status).toBe(413);
    expect(await prisma.healthUploadPart.count()).toBe(0);
  }, 30_000);

  it("refuses an empty part", async () => {
    const opened = await openUpload(alice.id, { fileName: "export.zip", fileSize: 100 });
    if (!opened.ok) throw new Error(opened.error);
    const stored = await receivePart(alice.id, {
      uploadId: opened.data.uploadId,
      seq: 0,
      body: new Blob([]).stream(),
    });
    expect(stored.ok).toBe(false);
  });

  it("caps how many uploads one account may hold at once", async () => {
    for (let index = 0; index < MAX_ACTIVE_UPLOADS; index += 1) {
      const opened = await openUpload(alice.id, { fileName: "export.zip", fileSize: 10 });
      expect(opened.ok).toBe(true);
    }
    const extra = await openUpload(alice.id, { fileName: "export.zip", fileSize: 10 });
    expect(extra.ok).toBe(false);
    if (extra.ok) return;
    expect(extra.error).toMatch(/already in progress/);

    // Another account is unaffected — the cap is per user, not global.
    expect((await openUpload(bob.id, { fileName: "export.zip", fileSize: 10 })).ok).toBe(true);
  });
});

describe("a part is safe to resend", () => {
  it("replaces rather than duplicates, so a retry cannot corrupt the archive", async () => {
    const archive = smallArchive();
    const opened = await openUpload(alice.id, { fileName: "export.zip", fileSize: archive.length });
    if (!opened.ok) throw new Error(opened.error);

    // The same part, three times — a flaky connection retrying.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stored = await putPart(alice, opened.data.uploadId, 0, archive);
      expect(stored.ok).toBe(true);
      if (!stored.ok) return;
      expect(stored.data.receivedParts).toBe(1);
      expect(stored.data.receivedBytes).toBe(archive.length);
    }
    expect(await prisma.healthUploadPart.count()).toBe(1);

    const result = await finalize(alice, opened.data.uploadId);
    expect(result.ok).toBe(true);
  });
});

describe("nothing is imported when staging is invalid", () => {
  it("refuses to assemble an upload that is missing a part", async () => {
    const archive = bulkyArchive(5 * 1024 * 1024);
    const opened = await openUpload(alice.id, { fileName: "export.zip", fileSize: archive.length });
    if (!opened.ok) throw new Error(opened.error);
    expect(opened.data.totalParts).toBeGreaterThan(1);

    // Everything but the last part.
    for (let seq = 0; seq < opened.data.totalParts - 1; seq += 1) {
      const start = seq * opened.data.partBytes;
      await putPart(alice, opened.data.uploadId, seq, archive.subarray(start, start + opened.data.partBytes));
    }

    const assembled = await assembleUpload(alice.id, opened.data.uploadId);
    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(assembled.error).toMatch(/incomplete/);
    // Nothing staged, nothing written, and the session is still there to be
    // completed or abandoned — an incomplete upload is not a corrupt one.
    expect(await prisma.healthImportSession.count()).toBe(0);
    expect(await prisma.healthMetric.count()).toBe(0);
  }, 60_000);

  it("refuses a completed upload whose bytes are not an export", async () => {
    const result = await stageThroughUpload(alice, Buffer.from("this is not a health export"));
    expect(result.ok).toBe(false);
    expect(await prisma.healthImportSession.count()).toBe(0);
    expect(await prisma.healthMetric.count()).toBe(0);
    // The parse consumed the upload either way: nothing is left behind.
    expect(await prisma.healthUploadSession.count()).toBe(0);
    expect(await prisma.healthUploadPart.count()).toBe(0);
  });

  it("refuses a second finalize of the same upload", async () => {
    const archive = smallArchive();
    const { uploadId } = await uploadInParts(alice, archive);

    const first = await assembleUpload(alice.id, uploadId);
    expect(first.ok).toBe(true);
    if (first.ok) scratch.push(first.data.directory);

    const second = await assembleUpload(alice.id, uploadId);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);

    await discardUpload(alice.id, uploadId);
  });

  it("refuses an expired upload and clears it", async () => {
    const archive = smallArchive();
    const { uploadId } = await uploadInParts(alice, archive);
    await prisma.healthUploadSession.update({
      where: { id: uploadId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const assembled = await assembleUpload(alice.id, uploadId);
    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(assembled.status).toBe(410);
    expect(await prisma.healthUploadSession.count()).toBe(0);
    expect(await prisma.healthUploadPart.count()).toBe(0);
  });
});

describe("ownership", () => {
  it("another account cannot add a part to your upload", async () => {
    const opened = await openUpload(alice.id, { fileName: "export.zip", fileSize: 100 });
    if (!opened.ok) throw new Error(opened.error);

    const stored = await receivePart(bob.id, {
      uploadId: opened.data.uploadId,
      seq: 0,
      body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
    });
    expect(stored.ok).toBe(false);
    if (stored.ok) return;
    // Not "forbidden" — it does not resolve at all, so there is nothing to
    // learn by trying ids.
    expect(stored.status).toBe(404);
    expect(await prisma.healthUploadPart.count()).toBe(0);
  });

  it("another account cannot assemble or parse your upload", async () => {
    const { uploadId } = await uploadInParts(alice, smallArchive());

    const assembled = await assembleUpload(bob.id, uploadId);
    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(assembled.status).toBe(404);

    // And Alice's upload is untouched by the attempt.
    const mine = await assembleUpload(alice.id, uploadId);
    expect(mine.ok).toBe(true);
    if (mine.ok) {
      scratch.push(mine.data.directory);
      await discardUpload(alice.id, uploadId);
    }
  });

  it("another account cannot discard your upload", async () => {
    const opened = await openUpload(alice.id, { fileName: "export.zip", fileSize: 100 });
    if (!opened.ok) throw new Error(opened.error);

    await discardUpload(bob.id, opened.data.uploadId);
    expect(await prisma.healthUploadSession.count()).toBe(1);

    await discardUpload(alice.id, opened.data.uploadId);
    expect(await prisma.healthUploadSession.count()).toBe(0);
  });

  it("an import staged through an upload only ever writes rows the uploader owns", async () => {
    const staged = await stageThroughUpload(alice, smallArchive());
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    const confirmed = await confirmHealthImport(
      alice.id,
      staged.preview.token,
      staged.preview.categories.map((category) => category.key),
    );
    expect(confirmed.ok).toBe(true);

    const foreign = await prisma.healthMetric.count({ where: { NOT: { userId: alice.id } } });
    expect(foreign).toBe(0);
    expect(await prisma.healthMetric.count({ where: { userId: alice.id } })).toBeGreaterThan(0);
  });
});

describe("cleanup", () => {
  it("deletes the parts as soon as the archive has been parsed", async () => {
    const result = await stageThroughUpload(alice, smallArchive());
    expect(result.ok).toBe(true);
    expect(await prisma.healthUploadSession.count()).toBe(0);
    expect(await prisma.healthUploadPart.count()).toBe(0);
  });

  it("sweeps an expired upload, and its parts with it", async () => {
    const { uploadId } = await uploadInParts(alice, smallArchive());
    expect(await prisma.healthUploadPart.count()).toBeGreaterThan(0);

    // Not yet: an upload inside its window is nobody's business to remove.
    expect(await sweepExpiredUploads()).toBe(0);
    expect(await prisma.healthUploadSession.count()).toBe(1);

    await prisma.healthUploadSession.update({
      where: { id: uploadId },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect(await sweepExpiredUploads()).toBe(1);
    expect(await prisma.healthUploadSession.count()).toBe(0);
    expect(await prisma.healthUploadPart.count()).toBe(0);
  });

  it("sweeps expired uploads when a new one is opened, including other accounts'", async () => {
    const stale = await openUpload(bob.id, { fileName: "old.zip", fileSize: 10 });
    if (!stale.ok) throw new Error(stale.error);
    await prisma.healthUploadSession.update({
      where: { id: stale.data.uploadId },
      data: { expiresAt: new Date(Date.now() - 1) },
    });

    const fresh = await openUpload(alice.id, { fileName: "export.zip", fileSize: 10 });
    expect(fresh.ok).toBe(true);
    expect(await prisma.healthUploadSession.count()).toBe(1);
  });

  it("gives a session an expiry inside the documented window", async () => {
    const opened = await openUpload(alice.id, { fileName: "export.zip", fileSize: 10 });
    if (!opened.ok) throw new Error(opened.error);
    const ahead = new Date(opened.data.expiresAt).getTime() - Date.now();
    expect(ahead).toBeGreaterThan(UPLOAD_TTL_MS - 60_000);
    expect(ahead).toBeLessThanOrEqual(UPLOAD_TTL_MS);
  });

  it("clears an upload that never sent a part, without waiting out the idle window", async () => {
    // The shape observed for real while verifying this in a browser: a tab that
    // goes away between "open the session" and "send the first part" leaves a
    // session holding zero bytes. Two of those used to spend both of an
    // account's upload slots for fifteen minutes, for nothing.
    for (let index = 0; index < MAX_ACTIVE_UPLOADS; index += 1) {
      const opened = await openUpload(alice.id, { fileName: "export.zip", fileSize: 10 });
      if (!opened.ok) throw new Error(opened.error);
      await prisma.healthUploadSession.update({
        where: { id: opened.data.uploadId },
        // Old enough to be dead, recent enough that the idle rule alone would
        // still be protecting it.
        data: { createdAt: new Date(Date.now() - UPLOAD_UNSTARTED_MS - 1_000) },
      });
    }

    const fresh = await openUpload(alice.id, { fileName: "export.zip", fileSize: 10 });
    expect(fresh.ok).toBe(true);
    expect(await prisma.healthUploadSession.count({ where: { userId: alice.id } })).toBe(1);
  });

  it("does not evict an upload that is genuinely mid-flight", async () => {
    // The other side of the rule above: a session with parts in it is somebody's
    // upload, however long ago it was created.
    const archive = smallArchive();
    const { uploadId } = await uploadInParts(alice, archive);
    await prisma.healthUploadSession.update({
      where: { id: uploadId },
      data: { createdAt: new Date(Date.now() - UPLOAD_UNSTARTED_MS - 60_000) },
    });

    const another = await openUpload(alice.id, { fileName: "second.zip", fileSize: 10 });
    expect(another.ok).toBe(true);
    // Still there, still complete, still finalizable.
    expect(await prisma.healthUploadSession.count({ where: { id: uploadId } })).toBe(1);
    const result = await finalize(alice, uploadId);
    expect(result.ok).toBe(true);
  });

  it("clears the account's own abandoned uploads instead of locking it out", async () => {
    // Two tabs closed mid-upload would otherwise hold both slots for an hour.
    for (let index = 0; index < MAX_ACTIVE_UPLOADS; index += 1) {
      const opened = await openUpload(alice.id, { fileName: "export.zip", fileSize: 10 });
      if (!opened.ok) throw new Error(opened.error);
      await prisma.healthUploadSession.update({
        where: { id: opened.data.uploadId },
        data: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) },
      });
    }

    const fresh = await openUpload(alice.id, { fileName: "export.zip", fileSize: 10 });
    expect(fresh.ok).toBe(true);
    expect(await prisma.healthUploadSession.count({ where: { userId: alice.id } })).toBe(1);
  });
});

describe("the import behaviour the staged path must not change", () => {
  it("detects duplicates when the same export is uploaded twice", async () => {
    const archive = smallArchive();

    const first = await stageThroughUpload(alice, archive);
    if (!first.ok) throw new Error(first.error);
    const categories = first.preview.categories.map((category) => category.key);
    const confirmed = await confirmHealthImport(alice.id, first.preview.token, categories);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.outcome.imported).toBeGreaterThan(0);

    const again = await stageThroughUpload(alice, archive);
    if (!again.ok) throw new Error(again.error);
    // Every row the second upload carries is one the first already wrote.
    for (const category of again.preview.categories) {
      expect(category.newRows, category.key).toBe(0);
      expect(category.updatedRows, category.key).toBe(0);
    }

    const second = await confirmHealthImport(
      alice.id,
      again.preview.token,
      again.preview.categories.map((category) => category.key),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.outcome.imported).toBe(0);
    expect(second.outcome.duplicates).toBeGreaterThan(0);
  });

  it("records the run in the history and undoes it", async () => {
    const staged = await stageThroughUpload(alice, smallArchive());
    if (!staged.ok) throw new Error(staged.error);
    const confirmed = await confirmHealthImport(
      alice.id,
      staged.preview.token,
      staged.preview.categories.map((category) => category.key),
    );
    expect(confirmed.ok).toBe(true);

    const batches = await listImportBatches(alice.id);
    expect(batches).toHaveLength(1);
    expect(batches[0].fileName).toBe("export.zip");
    expect(batches[0].fileSize).toBeGreaterThan(0);

    const before = await prisma.healthMetric.count({ where: { userId: alice.id } });
    expect(before).toBeGreaterThan(0);

    const removed = await removeImportBatch(alice.id, batches[0].id);
    expect(removed.ok).toBe(true);
    expect(await prisma.healthMetric.count({ where: { userId: alice.id } })).toBe(0);
  });
});

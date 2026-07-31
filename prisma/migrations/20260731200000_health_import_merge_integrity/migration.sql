-- Health import automation: smart-merge accounting and format-version awareness.
--
-- Additive only. Two columns on HealthImportBatch, both with defaults, so every
-- existing batch keeps its meaning:
--
--   protectedRows  readings a re-import left alone because they were no longer
--                  the import's to change (entered by hand, or edited by the
--                  user after an earlier import wrote them). Distinct from
--                  `duplicates`, which means "already identical, nothing to do".
--                  Batches written before smart merge default to 0, which is
--                  exactly what they did: the old pipeline overwrote instead of
--                  protecting, so it protected nothing.
--
--   formatVersion  which version of the import pipeline produced the batch.
--                  Existing rows default to 1 — the pipeline as it stood when
--                  they were written.
--
-- No index is added: the history and dashboard queries are already served by
-- the existing (userId, createdAt) and (userId, status) indexes.

ALTER TABLE "HealthImportBatch" ADD COLUMN "protectedRows" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "HealthImportBatch" ADD COLUMN "formatVersion" INTEGER NOT NULL DEFAULT 1;

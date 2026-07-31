import type { Metadata } from "next";
import Link from "next/link";
import { FileUp, History, Lock, ShieldCheck, Upload } from "lucide-react";

import { ImportWizard } from "@/components/health/import-wizard";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/db";
import { formatBytes, formatNumber } from "@/lib/utils";
import { listImportBatches } from "@/server/health-import";

export const metadata: Metadata = { title: "Import · Health" };
export const dynamic = "force-dynamic";

const STEPS = [
  { title: "Choose the file", detail: "Apple Health export.zip, its export.xml, or a CSV." },
  { title: "It uploads and is parsed on the server", detail: "Streamed, never held in memory." },
  { title: "Preview", detail: "Counts, date span and what is already present — nothing saved yet." },
  { title: "Choose what to bring in", detail: "Per category, so you can take steps but not nutrition." },
  { title: "Confirm", detail: "One transaction. Recorded as a batch you can undo later." },
];

export default async function HealthImportPage() {
  const user = await getCurrentUser();
  const batches = await listImportBatches(user.id, 3);

  return (
    <>
      <PageHeader
        title="Import health data"
        description="Bring an Apple Health export into Personal OS — previewed before anything is saved, and undoable afterwards."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/health/imports">
              <History /> Import history
            </Link>
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <SectionCard title="Import" icon={Upload} accent="text-domain-health">
            <ImportWizard />
          </SectionCard>

          <SectionCard title="How to export from Apple Health" icon={FileUp} accent="text-domain-planner">
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>Open the Health app on your iPhone.</li>
              <li>Tap your profile picture, top right.</li>
              <li>
                Scroll to the bottom and tap <strong>Export All Health Data</strong>.
              </li>
              <li>
                Wait for <code>export.zip</code> to be prepared — a decade of data can take several
                minutes — then save or AirDrop it to the device you are using here.
              </li>
              <li>Choose that file above.</li>
            </ol>
            <p className="mt-3 text-xs text-muted-foreground">
              The archive holds <code>export.xml</code> plus any ECGs, workout routes and clinical
              records. All of them are read; anything this app does not understand is counted and
              skipped rather than treated as an error.
            </p>
          </SectionCard>

          <SectionCard title="What happens, in order" icon={ShieldCheck} accent="text-domain-health">
            <ol className="space-y-2">
              {STEPS.map((step, index) => (
                <li key={step.title} className="flex gap-3 text-sm">
                  <span className="tabular flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                    {index + 1}
                  </span>
                  <span>
                    <span className="font-medium">{step.title}</span>
                    <span className="block text-xs text-muted-foreground">{step.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </SectionCard>
        </div>

        <div className="space-y-6">
          <SectionCard title="Your data, and only yours" icon={Lock} accent="text-domain-health">
            <ul className="space-y-2 text-xs text-muted-foreground">
              <li>
                <strong className="text-foreground">The upload is temporary.</strong> The file is
                streamed to a scratch path, parsed, and deleted before the preview appears — on
                every path, including failures.
              </li>
              <li>
                <strong className="text-foreground">Nothing is shared.</strong> Every record is
                written against your account and every query is scoped to it. No health data is ever
                sent anywhere else; the import code makes no network requests at all.
              </li>
              <li>
                <strong className="text-foreground">Nothing sensitive is copied.</strong> ECG voltage
                traces, GPS coordinates and raw clinical documents are read for their summary and
                then dropped.
              </li>
              <li>
                <strong className="text-foreground">Re-importing is safe.</strong> Every row carries
                a stable fingerprint, so importing the same export twice writes nothing new and a
                later export adds only what is genuinely new.
              </li>
              <li>
                <strong className="text-foreground">It is undoable.</strong> Each import is a batch;
                undoing one removes exactly what it wrote and still owns.
              </li>
            </ul>
          </SectionCard>

          <SectionCard
            title="Recent imports"
            icon={History}
            accent="text-muted-foreground"
            action={
              <Link
                href="/health/imports"
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                All
              </Link>
            }
          >
            {batches.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing imported yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {batches.map((batch) => (
                  <li key={batch.id} className="border-b pb-2 last:border-0 last:pb-0">
                    <p className="truncate font-medium">{batch.fileName}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatNumber(batch.imported)} new · {formatNumber(batch.duplicates)} already
                      present
                      {batch.fileSize ? ` · ${formatBytes(batch.fileSize)}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>
    </>
  );
}

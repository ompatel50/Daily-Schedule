"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FileUp, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { AccountView } from "@/components/finance/account-dialog";
import { formatDay } from "@/lib/date";
import { FINANCE_CATEGORY_META, type FinanceCategory } from "@/lib/enums";
import { formatMoney } from "@/lib/logic/finance";
import { FINANCE_CSV_FIELDS, type FinanceCsvField } from "@/lib/logic/finance-import";
import { cn, pluralize } from "@/lib/utils";
import {
  commitFinanceCsvImport,
  previewFinanceCsvImport,
  type FinanceImportPreview,
  type FinanceImportReport,
} from "@/server/actions/finance-import";

/** ~1 MB — matches the parser's own bound, checked before reading the file. */
const MAX_FILE_BYTES = 1_100_000;

const FIELD_LABELS: Record<FinanceCsvField, string> = {
  date: "Date",
  amount: "Amount",
  debit: "Debit",
  credit: "Credit",
  type: "Type",
  payee: "Description",
  category: "Category",
  notes: "Notes",
  currency: "Currency",
  account: "Account (ignored)",
};

/**
 * CSV import: pick a file, see exactly what would happen, then commit.
 * Nothing is written until "Import" — and re-importing the same file later
 * skips every row it already created.
 */
export function ImportCsvDialog({
  open,
  onOpenChange,
  accounts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Unarchived accounts to import into. */
  accounts: AccountView[];
}) {
  const router = useRouter();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [pending, startTransition] = React.useTransition();

  const [accountId, setAccountId] = React.useState("");
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [content, setContent] = React.useState<string | null>(null);
  const [dayFirst, setDayFirst] = React.useState(false);
  const [preview, setPreview] = React.useState<FinanceImportPreview | null>(null);
  const [report, setReport] = React.useState<FinanceImportReport | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setAccountId(accounts[0]?.id ?? "");
    setFileName(null);
    setContent(null);
    setDayFirst(false);
    setPreview(null);
    setReport(null);
  }, [open, accounts]);

  const requestPreview = React.useCallback(
    (args: { accountId: string; fileName: string; content: string; dayFirst: boolean }) => {
      startTransition(async () => {
        const result = await previewFinanceCsvImport({
          accountId: args.accountId,
          fileName: args.fileName,
          content: args.content,
          // Only force an order when the user flipped the switch; otherwise
          // let the parser auto-detect (and report ambiguity).
          dateOrder: args.dayFirst ? "dmy" : undefined,
        });
        if (result.ok) {
          setPreview(result.data);
        } else {
          setPreview(null);
          toast.error(result.error);
        }
      });
    },
    [],
  );

  async function pickFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast.error("That file is over 1 MB — split it and import the parts.");
      return;
    }
    const text = await file.text();
    setFileName(file.name);
    setContent(text);
    setReport(null);
    if (accountId) requestPreview({ accountId, fileName: file.name, content: text, dayFirst });
  }

  function changeAccount(next: string) {
    setAccountId(next);
    setReport(null);
    if (content && fileName) {
      requestPreview({ accountId: next, fileName, content, dayFirst });
    }
  }

  function changeDayFirst(next: boolean) {
    setDayFirst(next);
    setReport(null);
    if (content && fileName && accountId) {
      requestPreview({ accountId, fileName, content, dayFirst: next });
    }
  }

  function commit() {
    if (!content || !fileName || !accountId) return;
    startTransition(async () => {
      const result = await commitFinanceCsvImport({
        accountId,
        fileName,
        content,
        dateOrder: dayFirst ? "dmy" : undefined,
      });
      if (result.ok) {
        setReport(result.data);
        toast.success(
          `Imported ${result.data.createdCount} ${pluralize(result.data.createdCount, "transaction")} into ${result.data.accountName}`,
        );
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  const mappedFields = preview
    ? FINANCE_CSV_FIELDS.filter((field) => preview.mapping.headers[field] !== undefined)
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import transactions from CSV</DialogTitle>
          <DialogDescription>
            Nothing is written until you confirm — and importing the same file twice never
            duplicates a row.{" "}
            <a
              href="/finance-import-template.csv"
              download
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              Download the template
            </a>
            .
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="import-account">Into account</Label>
              <Select value={accountId} onValueChange={changeAccount}>
                <SelectTrigger id="import-account">
                  <SelectValue placeholder="Pick an account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name} · {account.currency}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="import-file">CSV file</Label>
              <input
                ref={fileRef}
                id="import-file"
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(event) => void pickFile(event.target.files?.[0])}
              />
              <Button
                type="button"
                variant="outline"
                className="w-full justify-start font-normal"
                onClick={() => fileRef.current?.click()}
              >
                <FileUp />
                <span className="truncate">{fileName ?? "Choose a file…"}</span>
              </Button>
            </div>
          </div>

          {preview && !report && (
            <>
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Detected columns
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {mappedFields.map((field) => (
                    <Badge key={field} variant="outline" className="text-[10px]">
                      {FIELD_LABELS[field]}: {preview.mapping.headers[field]}
                    </Badge>
                  ))}
                  {preview.mapping.unmapped.length > 0 && (
                    <Badge variant="muted" className="text-[10px]">
                      {preview.mapping.unmapped.length} ignored:{" "}
                      {preview.mapping.unmapped.slice(0, 4).join(", ")}
                      {preview.mapping.unmapped.length > 4 ? "…" : ""}
                    </Badge>
                  )}
                </div>

                {(preview.dateOrder !== "iso" || dayFirst) && (
                  <div className="flex items-center justify-between gap-3 pt-1">
                    <div>
                      <Label htmlFor="import-dayfirst" className="text-sm font-normal">
                        Dates are day-first (DD/MM/YYYY)
                      </Label>
                      {preview.dateOrderAmbiguous && (
                        <p className="text-xs text-amber-800 dark:text-amber-400">
                          The file&apos;s dates fit both readings — check the preview below.
                        </p>
                      )}
                    </div>
                    <Switch
                      id="import-dayfirst"
                      checked={dayFirst}
                      onCheckedChange={changeDayFirst}
                    />
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <span className="font-medium text-emerald-700 dark:text-emerald-400">
                  {preview.newCount} new
                </span>
                <span className={cn(preview.duplicateCount === 0 && "text-muted-foreground")}>
                  {preview.duplicateCount} already imported
                </span>
                <span
                  className={cn(
                    preview.invalidCount > 0
                      ? "font-medium text-red-700 dark:text-red-400"
                      : "text-muted-foreground",
                  )}
                >
                  {preview.invalidCount} invalid
                </span>
                <span className="text-muted-foreground">of {preview.rowCount} rows</span>
              </div>

              {preview.sample.length > 0 && (
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                        <th className="px-3 py-1.5 font-medium">Date</th>
                        <th className="px-3 py-1.5 font-medium">Description</th>
                        <th className="px-3 py-1.5 font-medium">Category</th>
                        <th className="px-3 py-1.5 text-right font-medium">Amount</th>
                        <th className="px-3 py-1.5 font-medium" aria-label="Status" />
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sample.map((row) => (
                        <tr key={row.line} className="border-b last:border-0">
                          <td className="whitespace-nowrap px-3 py-1.5">
                            {formatDay(row.date, "MMM d, yyyy")}
                          </td>
                          <td className="max-w-48 truncate px-3 py-1.5">
                            {row.payee ?? (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground">
                            {FINANCE_CATEGORY_META[row.category as FinanceCategory]?.label ??
                              row.category}
                          </td>
                          <td
                            className={cn(
                              "tabular whitespace-nowrap px-3 py-1.5 text-right",
                              row.amount > 0 && "text-emerald-700 dark:text-emerald-400",
                            )}
                          >
                            {row.amount > 0 ? "+" : ""}
                            {formatMoney(row.amount, preview.accountCurrency)}
                          </td>
                          <td className="px-3 py-1.5">
                            {row.status === "duplicate" && (
                              <Badge variant="muted" className="text-[10px]">
                                skip
                              </Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {preview.invalidShown.length > 0 && (
                <div className="space-y-1 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
                  <p className="text-xs font-medium text-red-700 dark:text-red-400">
                    {preview.invalidCount} {pluralize(preview.invalidCount, "row")} will be
                    rejected:
                  </p>
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {preview.invalidShown.map((problem) => (
                      <li key={`${problem.line}-${problem.message}`}>
                        Row {problem.line}: {problem.message}
                      </li>
                    ))}
                    {preview.invalidCount > preview.invalidShown.length && (
                      <li>…and {preview.invalidCount - preview.invalidShown.length} more.</li>
                    )}
                  </ul>
                </div>
              )}
            </>
          )}

          {report && (
            <div className="space-y-1 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
              <p className="font-medium">Import complete</p>
              <p className="text-muted-foreground">
                {report.createdCount} created · {report.skippedCount} skipped as duplicates ·{" "}
                {report.rejectedCount} rejected. Balances and summaries are up to date.
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <span />
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {report ? "Done" : "Cancel"}
            </Button>
            {!report && (
              <Button
                type="button"
                onClick={commit}
                disabled={pending || !preview || preview.newCount === 0}
              >
                {pending ? <Loader2 className="animate-spin" /> : <Upload />}
                {preview
                  ? `Import ${preview.newCount} ${pluralize(preview.newCount, "row")}`
                  : "Import"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

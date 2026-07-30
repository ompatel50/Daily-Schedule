"use client";

import * as React from "react";
import { Check, Copy, Download } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The one-time display of a freshly generated recovery-code batch. The
 * codes exist in plaintext only here, right now — the server keeps hashes —
 * so the component pushes the user to copy or download before moving on.
 */
export function RecoveryCodes({ codes, email }: { codes: string[]; email?: string }) {
  const [copied, setCopied] = React.useState(false);

  const fileText = React.useMemo(() => {
    const header = [
      "Personal OS — password recovery codes",
      email ? `Account: ${email}` : null,
      "Each code works exactly once. Keep this file somewhere safe and private.",
      "",
    ].filter((line): line is string => line !== null);
    return [...header, ...codes].join("\n") + "\n";
  }, [codes, email]);

  const [copyFailed, setCopyFailed] = React.useState(false);

  async function copy() {
    // Clipboard access can reject (a non-secure context — e.g. a self-hosted
    // instance over plain HTTP on a LAN — or a denied permission). Never
    // claim success it didn't achieve: on failure, point the user at the
    // download button, which always works.
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
    }
  }

  function download() {
    const blob = new Blob([fileText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "personal-os-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border bg-muted/40 p-4 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy codes"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <Download /> Download .txt
        </Button>
      </div>
      {copyFailed ? (
        <p role="alert" className="text-xs text-destructive">
          Couldn&apos;t copy to the clipboard here — use <strong>Download .txt</strong> to save your
          codes instead.
        </p>
      ) : null}
    </div>
  );
}

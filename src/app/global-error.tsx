"use client";

/**
 * Last-resort error boundary — reached only when the root layout itself
 * fails. Static markup, no app imports (anything imported here could be the
 * thing that crashed), and nothing technical revealed beyond the digest.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "4rem 1.5rem", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.25rem", marginBottom: "0.75rem" }}>Something went wrong</h1>
        <p style={{ color: "#666", maxWidth: "28rem", margin: "0 auto 1.5rem" }}>
          Your data is safe. Reload to try again.
          {error.digest ? ` (Reference: ${error.digest})` : ""}
        </p>
        <button
          onClick={reset}
          style={{ padding: "0.5rem 1.25rem", borderRadius: "0.5rem", border: "1px solid #ccc", cursor: "pointer" }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}

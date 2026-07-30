"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resetPasswordAction } from "@/server/actions/auth";

/**
 * "Forgot password" via a recovery code. One generic failure message for
 * every identity mistake — wrong email, wrong code, used code — so the form
 * confirms nothing about which accounts exist.
 */
export function ForgotPasswordForm({ minPasswordLength }: { minPasswordLength: number }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  // A real submit handler (not a `<form action>`) so React 19 does not
  // auto-reset on a failed attempt — retyping a 16-character recovery code
  // after every rejection would be miserable.
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const formData = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const result = await resetPasswordAction({
        email: String(formData.get("email") ?? ""),
        code: String(formData.get("code") ?? ""),
        newPassword: String(formData.get("password") ?? ""),
        confirm: String(formData.get("confirm") ?? ""),
      });
      if (result.ok) setDone(true);
      else setError(result.error);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Password reset</CardTitle>
          <CardDescription>
            The recovery code is now used up, and every device was signed out.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button asChild className="w-full">
            <Link href="/signin">Sign in with the new password</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">Reset your password</CardTitle>
        <CardDescription>
          Enter one of the recovery codes you saved when you created the account (or last
          generated in Settings). Each code works exactly once.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="reset-email">Email address</Label>
            <Input
              id="reset-email"
              name="email"
              type="email"
              required
              autoComplete="username"
              placeholder="you@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reset-code">Recovery code</Label>
            <Input
              id="reset-code"
              name="code"
              type="text"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="xxxx-xxxx-xxxx-xxxx"
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reset-password">New password</Label>
            <Input
              id="reset-password"
              name="password"
              type="password"
              required
              minLength={minPasswordLength}
              maxLength={200}
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reset-confirm">New password, again</Label>
            <Input
              id="reset-confirm"
              name="confirm"
              type="password"
              required
              minLength={minPasswordLength}
              maxLength={200}
              autoComplete="new-password"
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null} Reset password
          </Button>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          No codes left? If you run this deployment yourself, the offline reset script in the
          documentation can always set a new password.{" "}
          <Link href="/signin" className="font-medium text-foreground underline underline-offset-2">
            Back to sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

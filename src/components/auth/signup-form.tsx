"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import { RecoveryCodes } from "@/components/auth/recovery-codes";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signUpAction } from "@/server/actions/auth";

/**
 * The public sign-up form. Two states: the form itself, and — after the
 * account is created — the one-time recovery-code display, which is the
 * only chance to save them. Continuing from there enters the app (the
 * server action already signed this browser in).
 */
export function SignUpForm({ minPasswordLength }: { minPasswordLength: number }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<{
    email: string;
    recoveryCodes: string[];
    signedIn: boolean;
  } | null>(null);

  // A real submit handler (not a `<form action>`), so React 19 does not
  // auto-reset the fields after a failed attempt — a rejected sign-up keeps
  // everything the user typed instead of blanking the form.
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const formData = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const email = String(formData.get("email") ?? "");
      const result = await signUpAction({
        email,
        name: String(formData.get("name") ?? ""),
        password: String(formData.get("password") ?? ""),
        confirm: String(formData.get("confirm") ?? ""),
        // Honeypot: the server enforces it too, but sending the value keeps
        // the client and server checks in agreement.
        honeypot: String(formData.get("website") ?? ""),
      });
      if (result.ok) {
        setCreated({ email: email.trim().toLowerCase(), ...result });
      } else {
        setError(result.error);
      }
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Save your recovery codes</CardTitle>
          <CardDescription>
            Your account is ready. These codes are the only way to reset a forgotten password —
            this app never sends email. Each works once; they won&apos;t be shown again.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <RecoveryCodes codes={created.recoveryCodes} email={created.email} />
          <Button asChild className="w-full">
            {/* A full navigation, not a router push: the sign-in cookie was set
                by the server action and the app shell should load fresh. */}
            <a href={created.signedIn ? "/" : "/signin"}>
              {created.signedIn ? "I saved them — open Personal OS" : "I saved them — go to sign in"}
            </a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">Create your account</CardTitle>
        <CardDescription>
          Your own private space — planner, habits, nutrition, workouts and health. Only you can
          see your data.
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
            <Label htmlFor="signup-email">Email address</Label>
            <Input
              id="signup-email"
              name="email"
              type="email"
              required
              autoComplete="username"
              placeholder="you@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="signup-name">Name (optional)</Label>
            <Input id="signup-name" name="name" type="text" autoComplete="name" placeholder="How the app greets you" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="signup-password">Password</Label>
            <Input
              id="signup-password"
              name="password"
              type="password"
              required
              minLength={minPasswordLength}
              maxLength={200}
              autoComplete="new-password"
            />
            <p className="text-xs text-muted-foreground">
              At least {minPasswordLength} characters — a long passphrase beats a short complicated
              password.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="signup-confirm">Password, again</Label>
            <Input
              id="signup-confirm"
              name="confirm"
              type="password"
              required
              minLength={minPasswordLength}
              maxLength={200}
              autoComplete="new-password"
            />
          </div>
          <div aria-hidden="true" className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden">
            <label htmlFor="signup-website">Leave this field empty</label>
            <input id="signup-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null} Create account
          </Button>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          Already have an account?{" "}
          <Link href="/signin" className="font-medium text-foreground underline underline-offset-2">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

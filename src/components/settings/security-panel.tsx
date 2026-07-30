"use client";

import * as React from "react";
import { KeyRound, Loader2, LogOut } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/shared/section-card";
import { changePasswordAction, signOutEverywhereAction } from "@/server/actions/auth";

/**
 * Password change + "sign out everywhere". Both work through `tokenVersion`:
 * bumping it kills every session token issued before the bump, so a password
 * change locks out every other device immediately (this browser is signed
 * back in server-side), and "sign out everywhere" is the same bump without
 * a new password.
 */
export function SecurityPanel({
  minPasswordLength,
  lastLoginAt,
  lastFailedLoginAt,
}: {
  minPasswordLength: number;
  /** ISO timestamps (or null) — the single-owner "was that me?" audit trail. */
  lastLoginAt: string | null;
  lastFailedLoginAt: string | null;
}) {
  const [busy, setBusy] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);

  async function submit(formData: FormData) {
    setBusy(true);
    try {
      const result = await changePasswordAction({
        currentPassword: String(formData.get("current") ?? ""),
        newPassword: String(formData.get("next") ?? ""),
        confirm: String(formData.get("confirm") ?? ""),
      });
      if (result.ok) {
        toast.success("Password changed — every other device is now signed out");
        formRef.current?.reset();
      } else {
        toast.error(result.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="Sign-in & security"
      icon={KeyRound}
      accent="text-rose-500"
      description="Your password, and every signed-in device"
    >
      <div className="space-y-5">
        {(lastLoginAt || lastFailedLoginAt) && (
          <p className="text-xs text-muted-foreground" suppressHydrationWarning>
            {lastLoginAt ? `Last sign-in: ${new Date(lastLoginAt).toLocaleString()}.` : null}
            {lastFailedLoginAt
              ? ` Last failed attempt: ${new Date(lastFailedLoginAt).toLocaleString()}. If that wasn't you, change the password below.`
              : null}
          </p>
        )}

        <form ref={formRef} action={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                name="current"
                type="password"
                required
                autoComplete="current-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                name="next"
                type="password"
                required
                minLength={minPasswordLength}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-password">New password, again</Label>
              <Input
                id="confirm-password"
                name="confirm"
                type="password"
                required
                minLength={minPasswordLength}
                autoComplete="new-password"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              At least {minPasswordLength} characters. Changing it signs out every other device.
            </p>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <KeyRound />} Change password
            </Button>
          </div>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
          <p className="max-w-md text-sm text-muted-foreground">
            Signed in somewhere you shouldn&apos;t have? End every session, including this one.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void signOutEverywhereAction();
            }}
          >
            <LogOut /> Sign out everywhere
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

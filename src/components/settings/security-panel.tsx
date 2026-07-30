"use client";

import * as React from "react";
import { KeyRound, LifeBuoy, Loader2, LogOut } from "lucide-react";
import { toast } from "sonner";

import { RecoveryCodes } from "@/components/auth/recovery-codes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/shared/section-card";
import {
  changePasswordAction,
  regenerateRecoveryCodesAction,
  signOutEverywhereAction,
} from "@/server/actions/auth";

/**
 * Password change, recovery codes and "sign out everywhere". Password
 * change and sign-out-everywhere work through `tokenVersion`: bumping it
 * kills every session token issued before the bump, so a password change
 * locks out every other device immediately (this browser is signed back in
 * server-side). Recovery codes are the "forgot password" proof — hashed
 * server-side, displayed only at generation time.
 */
export function SecurityPanel({
  minPasswordLength,
  lastLoginAt,
  lastFailedLoginAt,
  recoveryCodesRemaining,
  email,
}: {
  minPasswordLength: number;
  /** ISO timestamps (or null) — the account's "was that me?" audit trail. */
  lastLoginAt: string | null;
  lastFailedLoginAt: string | null;
  /** Unused recovery codes left on the account. */
  recoveryCodesRemaining: number;
  email: string | null;
}) {
  const [busy, setBusy] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);
  const codesFormRef = React.useRef<HTMLFormElement>(null);
  const [freshCodes, setFreshCodes] = React.useState<string[] | null>(null);
  const [remaining, setRemaining] = React.useState(recoveryCodesRemaining);

  async function regenerate(formData: FormData) {
    setBusy(true);
    try {
      const result = await regenerateRecoveryCodesAction({
        currentPassword: String(formData.get("codes-password") ?? ""),
      });
      if (result.ok) {
        setFreshCodes(result.data.recoveryCodes);
        setRemaining(result.data.recoveryCodes.length);
        codesFormRef.current?.reset();
        toast.success("New recovery codes generated — the old ones no longer work");
      } else {
        toast.error(result.error);
      }
    } finally {
      setBusy(false);
    }
  }

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

        <div className="space-y-3 rounded-lg border px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <LifeBuoy className="size-4 text-muted-foreground" />
              <p className="text-sm">
                Recovery codes
                <span className="ml-2 text-xs text-muted-foreground">
                  {remaining} unused — each resets a forgotten password once
                </span>
              </p>
            </div>
          </div>
          {freshCodes ? (
            <RecoveryCodes codes={freshCodes} email={email ?? undefined} />
          ) : (
            <form ref={codesFormRef} action={regenerate} className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1 space-y-1.5">
                <Label htmlFor="codes-password">Current password</Label>
                <Input
                  id="codes-password"
                  name="codes-password"
                  type="password"
                  required
                  autoComplete="current-password"
                />
              </div>
              <Button type="submit" variant="outline" size="sm" disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <LifeBuoy />} Generate new codes
              </Button>
              <p className="w-full text-xs text-muted-foreground">
                Generating a new batch invalidates every old code. You&apos;ll see the new ones
                exactly once — save them somewhere safe.
              </p>
            </form>
          )}
        </div>

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

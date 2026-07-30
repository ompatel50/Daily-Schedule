import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SignUpForm } from "@/components/auth/signup-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/server/auth";
import { MIN_PASSWORD_LENGTH } from "@/server/auth/policy";
import { signupsDisabled } from "@/server/auth/signup";

export const metadata: Metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

/**
 * Public registration. No invite, no token, no allowlist — anyone can
 * create an account and gets an empty, fully isolated space of their own.
 * Abuse protection (rate limit, honeypot) lives in the sign-up action.
 */
export default async function SignUpPage() {
  const session = await auth();
  if (session?.user) redirect("/");

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      {signupsDisabled() ? (
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">Sign-ups are paused</CardTitle>
            <CardDescription>
              This deployment isn&apos;t accepting new accounts right now. Existing accounts can{" "}
              <Link href="/signin" className="font-medium text-foreground underline underline-offset-2">
                sign in
              </Link>{" "}
              as usual.
            </CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
      ) : (
        <SignUpForm minPasswordLength={MIN_PASSWORD_LENGTH} />
      )}
    </main>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { auth, signIn } from "@/server/auth";
import { setupAvailable } from "@/server/auth/setup";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

/**
 * The only page a signed-out visitor ever sees. Deliberately quiet: no
 * feature tour, no registration, and one error message for every kind of
 * sign-in failure — wrong password, unknown email, not allowlisted and
 * locked-out all read identically, so the page confirms nothing about which
 * accounts exist. Sign-in is in-app email + password; no external identity
 * provider is involved.
 */
const ERROR_MESSAGES: Record<string, string> = {
  CredentialsSignin:
    "Those details didn't sign you in. Check the email address and password and try again — after several failed tries, sign-in pauses for 15 minutes.",
  Configuration:
    "Sign-in isn't fully configured yet. If you are the owner, check the authentication environment variables.",
};

const DEFAULT_ERROR = "Sign-in didn't complete. Please try again.";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; setup?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");

  const params = await searchParams;
  const error = params.error ? (ERROR_MESSAGES[params.error] ?? DEFAULT_ERROR) : null;
  const justSetUp = params.setup === "done";
  // While the one-time owner setup is still open, point the owner at it.
  const showSetupLink = await setupAvailable();

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Personal OS</CardTitle>
          <CardDescription>A private space. Sign in to continue.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {justSetUp ? (
            <p
              role="status"
              className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
            >
              Owner account created. Sign in with the email address and password you just chose.
            </p>
          ) : null}
          {error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          <form
            className="space-y-3"
            action={async (formData: FormData) => {
              "use server";
              try {
                await signIn("password", {
                  email: String(formData.get("email") ?? ""),
                  password: String(formData.get("password") ?? ""),
                  redirectTo: "/",
                });
              } catch (error) {
                // A successful sign-in "throws" the redirect — let it pass.
                if (error instanceof AuthError) {
                  redirect("/signin?error=CredentialsSignin");
                }
                throw error;
              }
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="username"
                placeholder="you@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
              />
            </div>
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>

          {showSetupLink ? (
            <p className="rounded-md border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">
              First time here?{" "}
              <Link href="/setup" className="font-medium text-foreground underline underline-offset-2">
                Create the owner account
              </Link>{" "}
              — you&apos;ll need the setup token from your deployment.
            </p>
          ) : null}

          <p className="text-center text-xs text-muted-foreground">
            No public registration. Forgot the password? See the recovery steps in the
            documentation.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

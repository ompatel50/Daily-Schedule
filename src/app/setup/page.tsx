import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { completeSetup, setupAvailable, MIN_PASSWORD_LENGTH } from "@/server/auth/setup";

export const metadata: Metadata = { title: "Owner setup" };
export const dynamic = "force-dynamic";

/**
 * The one-time owner setup form. Exists only while `AUTH_SETUP_TOKEN` is set
 * and no account has a password yet (src/server/auth/setup.ts); at any other
 * time it redirects to the sign-in page. No external identity provider, no
 * billing account, no credit card — the setup token from the deployment
 * environment is the entire proof of ownership.
 */
const ERROR_MESSAGES: Record<string, string> = {
  disabled: "Setup is not enabled on this deployment.",
  done: "Setup has already been completed.",
  mismatch: "The two passwords don't match.",
  short: `Use at least ${MIN_PASSWORD_LENGTH} characters — a long passphrase beats a short complicated password.`,
  weak: "Don't build the password around your email address — pick something unrelated.",
  rejected: "The setup token or email address wasn't accepted.",
};

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (!(await setupAvailable())) redirect("/signin");

  const params = await searchParams;
  const error = params.error ? (ERROR_MESSAGES[params.error] ?? ERROR_MESSAGES.rejected) : null;

  async function submit(formData: FormData) {
    "use server";
    const result = await completeSetup({
      token: String(formData.get("token") ?? ""),
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      confirm: String(formData.get("confirm") ?? ""),
    });
    if (!result.ok) redirect(`/setup?error=${result.error}`);
    redirect("/signin?setup=done");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Owner setup</CardTitle>
          <CardDescription>
            Create the owner account for this Personal OS. This form works exactly once, then
            disappears.
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

          <form action={submit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="setup-token">Setup token</Label>
              <Input
                id="setup-token"
                name="token"
                type="password"
                required
                autoComplete="off"
                placeholder="AUTH_SETUP_TOKEN from your deployment"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="setup-email">Email address</Label>
              <Input
                id="setup-email"
                name="email"
                type="email"
                required
                autoComplete="username"
                placeholder="you@example.com"
              />
              <p className="text-xs text-muted-foreground">
                Must be listed in <code className="text-[11px]">ALLOWED_EMAILS</code>.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="setup-password">Password</Label>
              <Input
                id="setup-password"
                name="password"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="setup-confirm">Password, again</Label>
              <Input
                id="setup-confirm"
                name="confirm"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
              />
            </div>
            <Button type="submit" className="w-full">
              Create owner account
            </Button>
          </form>

          <p className="text-center text-xs text-muted-foreground">
            After setup, remove <code className="text-[11px]">AUTH_SETUP_TOKEN</code> from the
            environment. Nothing else uses it.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

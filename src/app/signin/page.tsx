import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { auth, signIn } from "@/server/auth";

export const metadata: Metadata = { title: "Sign in" };

/**
 * The only page a signed-out visitor ever sees. Deliberately quiet: no
 * feature tour, no registration — this is a private application, and the
 * error messages never reveal whether an email exists, only that access
 * requires an approved account.
 */
const ERROR_MESSAGES: Record<string, string> = {
  AccessDenied:
    "This Google account isn't approved for this Personal OS. Ask the owner to add your email address, then try again.",
  CredentialsSignin:
    "That email address isn't approved for this Personal OS. Ask the owner to add it, then try again.",
  Configuration:
    "Sign-in isn't fully configured yet. If you are the owner, check the authentication environment variables.",
  Verification: "That sign-in link is no longer valid. Please try again.",
};

const DEFAULT_ERROR = "Sign-in didn't complete. Please try again.";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");

  const params = await searchParams;
  const error = params.error ? (ERROR_MESSAGES[params.error] ?? DEFAULT_ERROR) : null;
  const devLogin = process.env.DANGEROUSLY_ENABLE_DEV_LOGIN === "1" && !process.env.VERCEL;

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Personal OS</CardTitle>
          <CardDescription>
            A private space. Sign in with an approved Google account to continue.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/" });
            }}
          >
            <Button type="submit" className="w-full">
              Continue with Google
            </Button>
          </form>

          {devLogin ? (
            <form
              className="space-y-2 rounded-md border border-dashed border-amber-400/60 p-3"
              action={async (formData: FormData) => {
                "use server";
                try {
                  await signIn("dev-login", {
                    email: String(formData.get("email") ?? ""),
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
              <Label htmlFor="dev-email" className="text-xs font-medium text-amber-600 dark:text-amber-400">
                Development sign-in (never enabled in production)
              </Label>
              <Input id="dev-email" name="email" type="email" required placeholder="you@example.com" />
              <Button type="submit" variant="outline" className="w-full">
                Sign in without Google
              </Button>
            </form>
          ) : null}

          <p className="text-center text-xs text-muted-foreground">
            No public registration. Access is limited to approved email addresses.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

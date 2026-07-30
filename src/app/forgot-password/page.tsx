import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { auth } from "@/server/auth";
import { MIN_PASSWORD_LENGTH } from "@/server/auth/policy";

export const metadata: Metadata = { title: "Reset password" };
export const dynamic = "force-dynamic";

/**
 * Password reset by recovery code — the free, offline-friendly alternative
 * to email reset links (this app sends no email). Signed-in visitors have
 * nothing to reset here and go home; Settings owns "change password".
 */
export default async function ForgotPasswordPage() {
  const session = await auth();
  if (session?.user) redirect("/");

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <ForgotPasswordForm minPasswordLength={MIN_PASSWORD_LENGTH} />
    </main>
  );
}

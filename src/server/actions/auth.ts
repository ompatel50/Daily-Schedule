"use server";

import { signOut } from "@/server/auth";

/** Ends the session and lands on the sign-in page. */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/signin" });
}

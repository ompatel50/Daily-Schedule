"use client";

import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The page-header "New task" button. It lives outside the client board, so it
 * opens the dialog the same way external links do: via `?new=1`, which the
 * board watches (and strips again when the dialog closes).
 */
export function NewTaskButton() {
  const router = useRouter();
  return (
    <Button onClick={() => router.push("/tasks?new=1", { scroll: false })}>
      <Plus /> New task
    </Button>
  );
}

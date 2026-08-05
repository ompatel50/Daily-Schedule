import Link from "next/link";
import { Compass } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Inside the authenticated shell, a wrong URL gets a way back, not a wall. */
export default function AppNotFound() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="max-w-md space-y-4 text-center">
        <Compass className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
        <h2 className="text-lg font-semibold">There&apos;s no page here</h2>
        <p className="text-sm text-muted-foreground">
          The address may be mistyped, or the thing it pointed at was deleted. Nothing was
          changed.
        </p>
        <Button asChild>
          <Link href="/">Back to the dashboard</Link>
        </Button>
      </div>
    </div>
  );
}

"use client";

import * as React from "react";
import { Bell, BellOff, Check } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/shared/section-card";

type Permission = "default" | "granted" | "denied" | "unsupported";

/**
 * Browser notifications are opt-in and only fire while a tab is open. That
 * limitation is stated plainly rather than papered over — a local-first app
 * with no server genuinely cannot deliver a notification when it isn't running.
 */
export function NotificationsPanel() {
  const [permission, setPermission] = React.useState<Permission>("default");

  React.useEffect(() => {
    if (typeof Notification === "undefined") setPermission("unsupported");
    else setPermission(Notification.permission as Permission);
  }, []);

  async function request() {
    if (typeof Notification === "undefined") return;
    const result = await Notification.requestPermission();
    setPermission(result as Permission);
    if (result === "granted") {
      new Notification("Personal OS", { body: "Reminders are on while this tab is open." });
      toast.success("Notifications enabled");
    } else {
      toast.error("Notifications were not allowed");
    }
  }

  return (
    <SectionCard
      title="Reminders"
      icon={Bell}
      accent="text-amber-500"
      description="Desktop notifications while the app is open"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-lg text-sm text-muted-foreground">
          {permission === "unsupported"
            ? "This browser doesn't support notifications — reminders still appear as in-app toasts."
            : permission === "granted"
              ? "Reminders will show as a desktop notification and an in-app toast while a Personal OS tab is open."
              : permission === "denied"
                ? "Notifications are blocked for this site. You can re-enable them in your browser's site settings — reminders will still appear as in-app toasts."
                : "Allow notifications to get reminded about scheduled blocks while the app is open."}
        </p>
        {permission === "default" && (
          <Button variant="outline" size="sm" onClick={request}>
            <Bell /> Enable notifications
          </Button>
        )}
        {permission === "granted" && (
          <span className="inline-flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
            <Check className="h-4 w-4" /> Enabled
          </span>
        )}
        {permission === "denied" && (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <BellOff className="h-4 w-4" /> Blocked
          </span>
        )}
      </div>
    </SectionCard>
  );
}

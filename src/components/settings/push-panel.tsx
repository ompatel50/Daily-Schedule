"use client";

import * as React from "react";
import { BellRing, Loader2, Smartphone, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/shared/section-card";
import {
  getPushStatusAction,
  subscribePushAction,
  unsubscribePushAction,
  type PushStatus,
} from "@/server/actions/push";

/**
 * Background reminders via Web Push. The honest constraints are stated in
 * the UI: the server must have push keys configured and a scheduled task
 * running, the browser must support push, and the user must grant
 * notification permission. Reminders themselves stay schedule-aware — the
 * push runner uses the same feed and the same exactly-once ledger as the
 * in-tab watcher, so nothing fires twice and nothing suppressed can fire.
 */

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function coarseDeviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Safari\//.test(ua) && !/Chrome/.test(ua)
        ? "Safari"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : "Browser";
  const os = /Mac/.test(ua)
    ? "Mac"
    : /Windows/.test(ua)
      ? "Windows"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} · ${os}` : browser;
}

export function PushPanel() {
  const [status, setStatus] = React.useState<PushStatus | null>(null);
  const [thisEndpoint, setThisEndpoint] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const supported =
    typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;

  const refresh = React.useCallback(async () => {
    const result = await getPushStatusAction();
    if (result.ok) setStatus(result.data);
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      setThisEndpoint(subscription?.endpoint ?? null);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function enable() {
    if (!status?.publicKey) return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast.error("Notifications were not allowed");
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(status.publicKey) as BufferSource,
      });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        toast.error("This browser produced an unusable subscription");
        return;
      }
      const saved = await subscribePushAction({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        deviceLabel: coarseDeviceLabel(),
      });
      if (saved.ok) {
        toast.success("Background reminders enabled on this device");
        await refresh();
      } else {
        toast.error(saved.error);
      }
    } catch {
      toast.error("Could not enable background reminders here");
    } finally {
      setBusy(false);
    }
  }

  async function disableThisDevice() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await unsubscribePushAction({ endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      toast.success("Background reminders disabled on this device");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await unsubscribePushAction({ id });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const thisDeviceSubscribed =
    thisEndpoint !== null && status !== null && status.subscriptions.length > 0;

  return (
    <SectionCard
      title="Background reminders"
      icon={BellRing}
      accent="text-amber-500"
      description="Push notifications, even with no tab open"
    >
      <div className="space-y-4">
        {!supported ? (
          <p className="text-sm text-muted-foreground">
            This browser doesn&apos;t support push notifications. Reminders still work as in-app
            toasts (and desktop notifications while a tab is open).
          </p>
        ) : status && !status.configured ? (
          <p className="text-sm text-muted-foreground">
            The server doesn&apos;t have push keys configured yet. Reminders still work while a tab
            is open; see the Web Push setup guide to enable background delivery.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-lg text-sm text-muted-foreground">
                {thisDeviceSubscribed
                  ? "This device receives reminders even when no Personal OS tab is open. Delivery follows your schedule exactly — nothing fires on rest days, for completed items, or twice."
                  : "Enable push on this device to get reminders with no tab open. In-app reminders keep working either way."}
              </p>
              {thisDeviceSubscribed ? (
                <Button variant="outline" size="sm" onClick={disableThisDevice} disabled={busy}>
                  {busy ? <Loader2 className="animate-spin" /> : <BellRing />} Disable on this device
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={enable} disabled={busy || !status}>
                  {busy ? <Loader2 className="animate-spin" /> : <BellRing />} Enable on this device
                </Button>
              )}
            </div>

            {status && status.subscriptions.length > 0 && (
              <ul className="space-y-1.5">
                {status.subscriptions.map((subscription) => (
                  <li
                    key={subscription.id}
                    className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
                  >
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">
                        {subscription.deviceLabel ?? "Unknown device"}
                        <span className="ml-2 text-xs text-muted-foreground">
                          since {subscription.createdAt.slice(0, 10)}
                        </span>
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${subscription.deviceLabel ?? "device"}`}
                      onClick={() => void revoke(subscription.id)}
                      disabled={busy}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}

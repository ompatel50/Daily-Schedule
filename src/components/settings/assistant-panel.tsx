"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Bot, CheckCircle2, Loader2, PlugZap, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionCard } from "@/components/shared/section-card";
import {
  ASSISTANT_MODES,
  ASSISTANT_MODE_META,
  type AssistantMode,
} from "@/lib/logic/assistant";
import {
  saveAssistantSettings,
  testAssistantConnection,
  type AssistantConnectionResult,
} from "@/server/actions/assistant";

/**
 * The assistant's whole configuration: where the user's Ollama server is,
 * which model to use, and how much the assistant may do. There is nothing
 * else to configure by design — no API key, no provider choice, no cloud.
 */

export interface AssistantSettingsValues {
  baseUrl: string | null;
  model: string | null;
  mode: AssistantMode;
}

export function AssistantPanel({ initial }: { initial: AssistantSettingsValues }) {
  const router = useRouter();
  const [baseUrl, setBaseUrl] = React.useState(initial.baseUrl ?? "");
  const [model, setModel] = React.useState(initial.model ?? "");
  const [mode, setMode] = React.useState<AssistantMode>(initial.mode);
  const [connection, setConnection] = React.useState<AssistantConnectionResult | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  async function test() {
    setTesting(true);
    try {
      const result = await testAssistantConnection({ baseUrl, record: true });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setConnection(result.data);
      if (result.data.reachable) {
        toast.success(`Ollama ${result.data.version} is reachable`, {
          description: `${result.data.models.length} model${result.data.models.length === 1 ? "" : "s"} available`,
        });
        // A saved model that vanished from the server stays selectable below;
        // picking the first available is only a convenience for empty state.
        if (!model && result.data.models.length > 0) setModel(result.data.models[0].name);
      } else {
        toast.error(result.data.error ?? "Could not reach the Ollama server");
      }
    } finally {
      setTesting(false);
    }
  }

  function save() {
    startTransition(async () => {
      const result = await saveAssistantSettings({
        baseUrl: baseUrl.trim(),
        model: model.trim() ? model.trim() : null,
        mode,
      });
      if (result.ok) {
        toast.success("Assistant settings saved");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  // The saved model plus everything the last test found, deduplicated — so
  // the select is useful before any test and after a server restart alike.
  const modelOptions = React.useMemo(() => {
    const names = new Set<string>();
    if (model.trim()) names.add(model.trim());
    if (initial.model) names.add(initial.model);
    for (const found of connection?.models ?? []) names.add(found.name);
    return [...names].sort();
  }, [model, initial.model, connection]);

  return (
    <div id="assistant">
      <SectionCard
        title="AI assistant"
        icon={Bot}
        accent="text-violet-500"
        description="Private, local-only — talks to your own Ollama server and nothing else"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Install Ollama on this machine or another on your network, pull a model that supports
            tool calling (for example <span className="font-medium">llama3.1</span> or{" "}
            <span className="font-medium">qwen2.5</span>), and point the assistant at it. Your data
            is only ever sent to the server you name here — no cloud AI, no API key, no card.
          </p>

          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="assistant-base-url">Ollama server URL</Label>
              <Input
                id="assistant-base-url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="http://localhost:11434"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void test()}
              disabled={testing || baseUrl.trim() === ""}
            >
              {testing ? <Loader2 className="animate-spin" /> : <PlugZap />} Test connection
            </Button>
          </div>

          {connection && (
            <p
              className="flex items-center gap-2 text-sm"
              data-testid="assistant-connection-result"
            >
              {connection.reachable ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span>
                    Connected — Ollama {connection.version},{" "}
                    {connection.models.length === 0
                      ? "no models yet (run `ollama pull llama3.1`)"
                      : `${connection.models.length} model${connection.models.length === 1 ? "" : "s"} available`}
                  </span>
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                  <span className="text-muted-foreground">{connection.error}</span>
                </>
              )}
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="assistant-model">Model</Label>
              <Select value={model || undefined} onValueChange={setModel}>
                <SelectTrigger id="assistant-model">
                  <SelectValue
                    placeholder={
                      modelOptions.length === 0 ? "Test the connection first" : "Choose a model"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="assistant-mode">Mode</Label>
              <Select value={mode} onValueChange={(value) => setMode(value as AssistantMode)}>
                <SelectTrigger id="assistant-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASSISTANT_MODES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {ASSISTANT_MODE_META[value].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{ASSISTANT_MODE_META[mode].description}</p>
            </div>
          </div>

          <div className="flex justify-end">
            <Button type="button" onClick={save} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : null} Save assistant settings
            </Button>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

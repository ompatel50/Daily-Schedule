"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, NotebookPen } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/shared/section-card";
import { cn } from "@/lib/utils";
import { saveJournalEntry } from "@/server/actions/health";

const MOODS = ["Rough", "Meh", "OK", "Good", "Great"];

export function JournalCard({
  date,
  entry,
}: {
  date: string;
  entry: { title: string | null; content: string; mood: number | null; energy: number | null } | null;
}) {
  const router = useRouter();
  const [content, setContent] = React.useState(entry?.content ?? "");
  const [mood, setMood] = React.useState<number | null>(entry?.mood ?? null);
  const [energy, setEnergy] = React.useState<number | null>(entry?.energy ?? null);
  const [saved, setSaved] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    setContent(entry?.content ?? "");
    setMood(entry?.mood ?? null);
    setEnergy(entry?.energy ?? null);
    setSaved(false);
  }, [entry, date]);

  const dirty =
    content !== (entry?.content ?? "") ||
    mood !== (entry?.mood ?? null) ||
    energy !== (entry?.energy ?? null);

  function save() {
    startTransition(async () => {
      const result = await saveJournalEntry({ date, content, mood, energy, title: null });
      if (result.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <SectionCard title="Notes" icon={NotebookPen} accent="text-amber-500">
      <div className="space-y-3">
        <Textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="How did today go?"
          className="min-h-[80px] resize-none text-sm"
        />

        <div className="space-y-2">
          <Scale label="Mood" value={mood} onChange={setMood} />
          <Scale label="Energy" value={energy} onChange={setEnergy} />
        </div>

        <Button
          size="sm"
          variant={dirty ? "default" : "outline"}
          className="w-full"
          onClick={save}
          disabled={pending || !dirty}
        >
          {pending ? <Loader2 className="animate-spin" /> : saved ? <Check /> : null}
          {saved ? "Saved" : dirty ? "Save note" : "Up to date"}
        </Button>
      </div>
    </SectionCard>
  );
}

function Scale({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((level) => (
          <button
            key={level}
            type="button"
            title={MOODS[level - 1]}
            onClick={() => onChange(value === level ? null : level)}
            className={cn(
              "h-6 w-6 rounded-md border text-[11px] font-medium transition-colors",
              value === level
                ? "border-primary bg-primary text-primary-foreground"
                : "hover:bg-accent",
            )}
          >
            {level}
          </button>
        ))}
      </div>
    </div>
  );
}

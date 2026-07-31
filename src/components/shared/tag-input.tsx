"use client";

import * as React from "react";
import { X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { normalizeTagName, TASK_TAG_LIMIT } from "@/lib/logic/tasks";
import { cn } from "@/lib/utils";

/**
 * Tag entry: type a name, press Enter (or comma) to add it. Creating a tag IS
 * typing it — there is no separate "manage tags" step — and existing tags are
 * offered through a native datalist so the vocabulary converges instead of
 * sprouting near-duplicates.
 *
 * Keyboard-only usable end to end: Enter adds, Backspace on an empty field
 * removes the last chip, and every chip's remove control is a real button in
 * the tab order.
 */
export function TagInput({
  id,
  value,
  onChange,
  suggestions = [],
  limit = TASK_TAG_LIMIT,
  placeholder = "Add a tag and press Enter",
  describedBy,
}: {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  /** Tag names that already exist, offered as completions. */
  suggestions?: string[];
  limit?: number;
  placeholder?: string;
  describedBy?: string;
}) {
  const [draft, setDraft] = React.useState("");
  const listId = `${id}-suggestions`;
  const full = value.length >= limit;

  function add(raw: string) {
    const name = normalizeTagName(raw);
    if (!name || full || value.includes(name)) {
      setDraft("");
      return;
    }
    onChange([...value, name]);
    setDraft("");
  }

  function remove(name: string) {
    onChange(value.filter((tag) => tag !== name));
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      // Enter must add a tag, never submit the surrounding form.
      event.preventDefault();
      add(draft);
      return;
    }
    if (event.key === "Backspace" && draft === "" && value.length > 0) {
      event.preventDefault();
      remove(value[value.length - 1]);
    }
  }

  const unused = suggestions.filter((name) => !value.includes(name));

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Selected tags">
          {value.map((name) => (
            <li key={name}>
              <span className="inline-flex items-center gap-1 rounded-full border bg-muted/60 py-0.5 pl-2 pr-1 text-xs">
                #{name}
                <button
                  type="button"
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => remove(name)}
                  aria-label={`Remove tag ${name}`}
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Input
        id={id}
        list={unused.length > 0 ? listId : undefined}
        value={draft}
        disabled={full}
        placeholder={full ? `Up to ${limit} tags` : placeholder}
        aria-describedby={describedBy}
        className={cn(full && "cursor-not-allowed")}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => add(draft)}
      />
      {unused.length > 0 && (
        <datalist id={listId}>
          {unused.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
    </div>
  );
}

"use client";

import * as React from "react";

/**
 * Session-scoped UI memory: the small, safe preferences that make navigation
 * feel continuous — a palette query you half-typed, recent commands, a
 * collapsed section. Rules:
 *
 *  * sessionStorage only — closing the browser forgets everything;
 *  * one namespace prefix, so sign-out can sweep the lot in one pass;
 *  * UI state only, never records: nothing here may hold finance amounts,
 *    health values, or anything else you'd mind another account seeing.
 *
 * Storage can always be unavailable (private browsing quotas, disabled
 * storage); every helper degrades to in-memory defaults silently.
 */
const PREFIX = "personal-os-ui:";

export function readUIState<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeUIState<T>(key: string, value: T): void {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota or disabled storage — the preference just doesn't stick.
  }
}

/** Sweep every namespaced key. Called on sign-out, before the redirect. */
export function clearClientUIState(): void {
  try {
    const doomed: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(PREFIX)) doomed.push(key);
    }
    for (const key of doomed) sessionStorage.removeItem(key);
  } catch {
    // Nothing stored, nothing to clear.
  }
}

/**
 * `useState` that survives navigation within this tab. Reads lazily on mount
 * (SSR-safe: the first render uses `initial`, then hydrates the stored value)
 * and writes on every change.
 */
export function usePersistedUIState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = React.useState<T>(initial);

  React.useEffect(() => {
    setValue((current) => {
      const stored = readUIState<T>(key, current);
      return stored;
    });
    // Read once per key — a remount re-reads, a re-render does not.
  }, [key]);

  const set = React.useCallback(
    (next: T) => {
      setValue(next);
      writeUIState(key, next);
    },
    [key],
  );

  return [value, set];
}

"use client";

import * as React from "react";

/**
 * Whether the viewport is phone-sized (below Tailwind's `sm` breakpoint).
 *
 * The app's responsiveness is otherwise pure CSS; this hook exists for the
 * few components that must render a *different structure* per form factor —
 * a bottom sheet instead of a centred dialog — where CSS alone cannot swap
 * the DOM. SSR-safe: the first render says `false` and corrects on mount,
 * which is fine for overlays that only open after user interaction.
 */
export function useIsMobile(query = "(max-width: 639px)"): boolean {
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return isMobile;
}

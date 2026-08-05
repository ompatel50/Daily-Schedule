# Responsive design & PWA

Personal OS is a desktop-strength app that now treats the phone as a first
class surface. This documents the architecture; the finish criteria are held
by the browser suites (`responsive.spec.ts`, `mobile-drawer.spec.ts`,
`planner-mobile.spec.ts`, `pwa.spec.ts`, `a11y.spec.ts`).

## The shell

* **Desktop (≥1024px)** keeps the permanent sidebar, topbar, and everything
  that already worked. Nothing moved.
* **Below 1024px** the sidebar hides and the topbar becomes the mobile
  header: a menu button (44px target), the page title, and the same quick
  actions. The menu opens a **slide-over navigation drawer**
  (`src/components/layout/mobile-nav.tsx`) on the `Sheet` primitive
  (`src/components/ui/sheet.tsx`, Radix Dialog underneath): focus trap,
  focus return to the trigger, Escape, backdrop tap, background scroll lock
  and `aria-modal` all come from Radix; the drawer adds close-on-navigate
  and the grouped destination list (Plan / Track / Review / App — headings,
  not folding; every destination stays one tap away), plus account info and
  sign-out. There is deliberately **no bottom navigation bar**.
* **Safe areas**: `viewport-fit=cover` plus `pt-safe` / `pb-safe` /
  `px-safe` utilities (globals.css) pad the header, drawer and content away
  from the notch and home indicator.
* **Reduced motion** is honoured globally — the existing
  `prefers-reduced-motion` override collapses sheet/dialog transitions.

## Shared responsive primitives

| Piece | Where | Job |
| --- | --- | --- |
| `Sheet` | ui/sheet.tsx | Slide-over panels: left = nav drawer, bottom = action/filter sheets |
| Phone-first `DialogContent` | ui/dialog.tsx | Every dialog: `max-h-[calc(100dvh-2rem)]`, viewport-margin width, internal scroll — nothing hides under the iOS keyboard or browser chrome |
| `OfflineIndicator` | shared/offline-indicator.tsx | Slim status bar while offline, "back online" toast |
| `.touch-target` | globals.css | ~44px hit areas on coarse pointers without changing visual size |
| `.hover-reveal` | globals.css | Hover-revealed row controls stay hover-only on fine pointers, always visible on touch |
| 16px inputs | globals.css | `@media (pointer: coarse)` keeps iOS Safari from zooming on focus |
| Route skeletons | `loading.tsx` per route | Page-shaped placeholders inside the persistent shell |
| `usePersistedUIState` | lib/client-state.ts | Session-scoped UI memory (palette recents etc.), swept on sign-out |

## Module behaviour on phones

* **Planner** — the priority surface. Day view is a focused single-day list
  (big tap rows, explicit edit/move controls, no hover dependency) above the
  proportional timeline, which extends past the 12 AM line so after-midnight
  blocks render at the end of the evening they belong to, with the
  current-time marker following. Week view stacks into seven readable day
  sections below `md` (drag & drop remains the desktop affordance; phones
  move items through the editor and "push to tomorrow"). Month cells drop to
  category dots below `sm`. Desktop grids are unchanged.
* **Assistant** — native-chat feel: dvh-bounded transcript that respects the
  iOS keyboard, auto-growing composer, 92%-width bubbles, wrapped tool
  output, 44px confirm/cancel on proposal cards, collapsed audit tool lists.
  The confirmation model is untouched.
* **Tables** — the app was already card-based; the two real tables (Health
  sleep and workout history) render as stacked record cards below `md` and
  keep the desktop table above it. Import-preview tables scroll inside their
  own `overflow-x-auto`.
* **Everything else** — boards stack, filters wrap as chip rows, row menus
  and checkboxes get `touch-target`, amounts/status stay prominent while
  metadata wraps underneath.

## PWA

* `public/manifest.webmanifest`: `standalone`, stable `id: "/"`, theme and
  background colours, 192/512/maskable icons (project-owned assets), plus an
  `apple-touch-icon` and `apple-mobile-web-app` metadata via the root
  layout — installable from iPhone Safari's Add to Home Screen.
* **Service worker** (`public/sw.js`): Web Push display/click-through plus a
  deliberately narrow cache — `/_next/static/*` (content-hashed, immutable),
  icons and the manifest, cache-first. **Never HTML, never `/api/*`, never a
  server action, never anything authenticated**: a private app must not risk
  serving one account's cached data to another, so offline support is
  honest — chrome may load, data needs a connection, and the offline bar
  says so. No write queueing, by design.
* **Updates**: a new worker waits instead of hot-swapping; the app shows one
  "new version ready" toast whose Reload action posts `SKIP_WAITING`
  (`shared/pwa-register.tsx`). Ignoring it applies the update on the next
  natural full load.
* **Sign-out** sweeps the session-scoped UI memory (`clearClientUIState`)
  before the redirect.

## Offline behaviour

Detection + a clear indicator, safe retry, and forms that keep typed input on
failure. Full offline editing is intentionally out of scope: no queued
writes — a queued finance change or import replayed later is a correctness
risk, not a convenience.

## Intentional limitations

* No bottom tab bar; the drawer is the one phone navigation.
* Touch drag-and-drop is not the primary mobile interaction anywhere;
  explicit controls do the same jobs.
* Dirty-form guards are limited to inputs that keep their text on failure —
  blanket "discard changes?" dialogs on every Cancel would train
  click-through.
* Keyboard shortcuts stay a hardware-keyboard affordance (the shortcuts
  button hides below `sm`).

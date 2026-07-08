---
name: app-motion
description: Micro-interactions and animation in app/ (React 19) using motion/react — Framer Motion v12 under its new name. Use when adding or refining animations, transitions, hover/press feedback, enter/exit effects, shimmer/loading states, AnimatePresence, layout animations, or any "make it feel smoother / add a micro-interaction" request that touches app/src. Triggers include "animate", "micro-interaction", "framer motion", "motion", "transition", "hover effect", "spring", "bounce", "fade/slide in".
---

# app-motion — micro-interactions in `app/`

Animation library is **`motion`** (`motion@12.x` — the official rebrand of Framer Motion; same API, same engine).

**Import only from `motion/react`.** `framer-motion` is NOT in `app/package.json` — don't add it or import it; a second package name for the same library invites duplicate module instances and version drift.

```tsx
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
```

In-repo reference implementations:

- `app/src/components/auth/AuthShell.tsx` — `AnimatePresence mode="wait"` content rotator (keyed card swap with enter/exit drift)
- `app/src/components/ai-elements/shimmer.tsx` — infinite background-position shimmer; module-level `motion.create()` cache for dynamic element types
- `app/src/components/ui/*` — shadcn primitives animated via **tw-animate-css** data-attribute utilities, *not* motion

## Two animation systems — pick the right one

1. **tw-animate-css / Tailwind utilities** (imported in `app/src/app.css`) for **state-driven open/close on Base UI primitives**: dialogs, popovers, dropdowns, tooltips, accordions. They already animate via `data-open:animate-in fade-in-0 zoom-in-95` / `data-closed:animate-out`. **Never retrofit motion/AnimatePresence onto these** — motion's exit handling fights Base UI's unmount timing for zero gain.
2. **motion/react** for everything Tailwind can't express: JS-driven values, exit animations on your own conditional renders, keyed content swaps, `layout` animations, gestures (`whileTap`/`whileHover`/`drag`), springs, staggered children, scroll-linked effects.

Simple hover/focus feedback (color, shadow, small translate) stays plain CSS: `transition-all hover:-translate-y-0.5` etc. — see the dot-pager in AuthShell. Reach for motion only when the interaction needs physics, sequencing, or mount/unmount choreography.

## House motion values

```tsx
const EASE = [0.22, 1, 0.36, 1] as const; // easeOutQuint — the house curve (AuthShell uses it)
```

- **Tap/press feedback**: 100–150ms, `whileTap={{ scale: 0.97 }}`
- **Hover states**: ~200ms
- **Content enter/exit, card swaps**: 300–450ms with `EASE` (AuthShell: `{ duration: 0.45, ease: EASE }`, ±12px y-drift)
- **Springs for toggles/drag/snappy UI**: `{ type: "spring", stiffness: 500, damping: 30 }`
- Nothing in app chrome over 500ms. Distance ≤ 16px for enters; micro-interactions move pixels, not viewports.

## Micro-interaction recipes

**Pressable button/card** (use on custom interactive surfaces, not on `ui/button.tsx` globally):

```tsx
<motion.button whileTap={{ scale: 0.97 }} transition={{ duration: 0.1 }} />
```

**Keyed content swap** (rotating cards, step changes, tab panels) — the AuthShell pattern:

```tsx
<AnimatePresence mode="wait">
  <motion.div
    key={current}
    initial={{ opacity: 0, y: 12 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -12 }}
    transition={{ duration: 0.45, ease: EASE }}
  />
</AnimatePresence>
```

**List add/remove** (chat messages, agent rows): `<AnimatePresence mode="popLayout">` + `layout` on each `motion.li`; enter `{ opacity: 0, y: 8 }`, exit `{ opacity: 0, height: 0 }` for collapse. Pairs with the optimistic-mutation convention — a temp row can enter dimmed and un-dim on refetch.

**Value-change tick** (counters, badges): remount on value via `key={value}` with a small `initial={{ scale: 0.9, opacity: 0 }}` pop.

**Dynamic element type**: never call `motion.create(el)` in render — cache at module level (copy the `getMotionComponent` map from `shimmer.tsx`).

## Hard rules

- **Animate only `transform` and `opacity`** (compositor-friendly). Width/height/top/left only via the `layout` prop, deliberately.
- **Don't animate the persistent shell.** `AppLayout` (sidebar + artifact pane) mounts once under `src/routes/_app/_app.tsx` and must never visually jump — that architecture exists to kill flash-on-navigation. Route-level enter animations on center-pane content: opacity-only and ≤150ms, or none.
- **Reduced motion**: the app has no global `MotionConfig` — use `useReducedMotion()` from `motion/react` in any component with non-trivial movement and collapse to opacity-only when it returns true.
- `cn()` lives at `app/src/lib/utils.ts`; theme tokens (oklch + `--color-fg-*`/`--color-bg-*`/`--color-accent-*`) in `app/src/app.css`.
- Verify with `vp check` in `app/`; eyeball at `http://localhost:5173` (tmux `-L bg` session `app`).

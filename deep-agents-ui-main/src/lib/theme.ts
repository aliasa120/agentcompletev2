/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║                    CENTRALIZED THEME TOKEN SYSTEM                       ║
 * ║                                                                          ║
 * ║  HOW TO CHANGE THE THEME:                                               ║
 * ║  1. Open src/app/globals.css                                            ║
 * ║  2. Edit the :root { } CSS variables (e.g. change --primary color)     ║
 * ║  3. Everything in the app updates automatically ✓                       ║
 * ║                                                                          ║
 * ║  DO NOT hardcode hex colors anywhere in components.                     ║
 * ║  Always import from this file or use Tailwind semantic classes.         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * CSS Variable Reference:
 *   All values here are references to CSS variables defined in globals.css :root
 *   They work in both light and dark mode automatically.
 *
 * Usage in components:
 *   import { cssVar, tw } from "@/lib/theme";
 *
 *   // For inline styles (borderColor, backgroundColor, etc.):
 *   style={{ borderLeftColor: cssVar.primary }}
 *
 *   // For Tailwind className (most cases):
 *   className={tw.text.primary}
 *   className={tw.bg.muted}
 */

// ─── CSS Variable References (for inline `style={}` props) ────────────────────
// Use these when you need a color in a JS expression, e.g. for canvas, SVG,
// Chart.js, borderTopColor, etc.
export const cssVar = {
  // Core brand
  primary:            "var(--primary)",
  primaryForeground:  "var(--primary-foreground)",

  // Surfaces
  background:         "var(--background)",
  card:               "var(--card)",
  cardForeground:     "var(--card-foreground)",
  sidebar:            "var(--sidebar)",
  muted:              "var(--muted)",
  accent:             "var(--accent)",
  popover:            "var(--popover)",

  // Text
  foreground:         "var(--foreground)",
  mutedForeground:    "var(--muted-foreground)",
  accentForeground:   "var(--accent-foreground)",
  secondaryForeground:"var(--secondary-foreground)",

  // Borders & inputs
  border:             "var(--border)",
  input:              "var(--input)",
  ring:               "var(--ring)",
  radius:             "var(--radius)",

  // Semantic status colors (defined in globals.css as app-specific vars)
  success:            "var(--color-success)",
  warning:            "var(--color-warning)",
  error:              "var(--color-error)",
  destructive:        "var(--destructive)",

  // Derived / transparent mixes — use CSS color-mix for dynamic variants
  primarySubtle:      "color-mix(in srgb, var(--primary) 10%, transparent)",
  primaryBorder:      "color-mix(in srgb, var(--primary) 30%, transparent)",
  primaryHalf:        "color-mix(in srgb, var(--primary) 50%, transparent)",
  mutedHalf:          "color-mix(in srgb, var(--muted-foreground) 50%, transparent)",
} as const;

// ─── Tailwind Class Strings (for className={} props) ──────────────────────────
// Use these to avoid hardcoding colour class names in components.
// If you ever change the Tailwind config, update here only.
export const tw = {
  text: {
    primary:          "text-primary",
    primaryForeground:"text-primary-foreground",
    foreground:       "text-foreground",
    muted:            "text-muted-foreground",
    secondary:        "text-secondary-foreground",
    destructive:      "text-destructive",
    success:          "text-success",
    warning:          "text-warning",
    error:            "text-destructive",
    brand:            "text-primary",
  },
  bg: {
    primary:          "bg-primary",
    primarySubtle:    "bg-primary/10",
    card:             "bg-card",
    muted:            "bg-muted",
    mutedLight:       "bg-muted/40",
    accent:           "bg-accent",
    sidebar:          "bg-sidebar",
    background:       "bg-background",
    successSubtle:    "bg-success-primary",
    warningSubtle:    "bg-warning-primary",
    destructiveSubtle:"bg-destructive/5",
  },
  border: {
    default:          "border-border",
    primary:          "border-primary",
    primarySubtle:    "border-primary/20",
    muted:            "border-muted",
    destructive:      "border-destructive/40",
    successSubtle:    "border-success/30",
    warningSubtle:    "border-warning/30",
  },
  badge: {
    // For status badges / pills — returns a full className string
    querying:   "bg-primary/10 text-primary ring-1 ring-primary/20",
    loading:    "bg-muted text-muted-foreground ring-1 ring-border",
    done:       "bg-primary/10 text-primary ring-1 ring-primary/20",
    success:    "bg-success-primary text-success border border-success/30",
    warning:    "bg-warning-primary text-warning border border-warning/30",
    error:      "bg-destructive/10 text-destructive border border-destructive/20",
    active:     "bg-primary/10 text-primary border border-primary/20",
    neutral:    "bg-muted text-muted-foreground border border-border",
  },
  status: {
    // For status dots / icons
    idle:       "bg-emerald-500",
    busy:       "bg-primary",
    interrupted:"bg-amber-500",
    error:      "bg-destructive",
  },
} as const;

// ─── Card accent colors (for CardShell's borderLeftColor) ─────────────────────
// All cards now use the primary CSS variable — one change in globals.css
// updates every card's accent simultaneously.
export const cardAccent = {
  default:     cssVar.primary,   // used by ALL cards
  search:      cssVar.primary,
  think:       cssVar.primary,
  extract:     cssVar.primary,
  imageSearch: cssVar.primary,
  imageGen:    cssVar.primary,
  geminiVision:cssVar.primary,
  publish:     cssVar.primary,
  dbSave:      cssVar.primary,
  fileWrite:   cssVar.primary,
  fileRead:    cssVar.primary,
  todo:        cssVar.primary,
  generic:     cssVar.primary,
} as const;

// ─── Helper: spinner style (for circular loading spinners) ───────────────────
// Usage: style={spinnerStyle()}
export function spinnerStyle(size = 36) {
  return {
    width:  size,
    height: size,
    borderTopColor:   cssVar.primary,
    borderRightColor: cssVar.primaryHalf,
    animation: "spinnerRotate 0.75s linear infinite",
  } as React.CSSProperties;
}

// ─── Helper: build card border style ─────────────────────────────────────────
export function cardBorderStyle(accentColor: string = cssVar.primary) {
  return {
    animation: "cardSlideIn 0.28s cubic-bezier(0.16,1,0.3,1) both",
    borderLeftColor: accentColor,
    borderLeftWidth: "3px",
    boxShadow: "0 1px 4px rgba(0,0,0,0.04), 0 0 0 0.5px rgba(0,0,0,0.04)",
  } as React.CSSProperties;
}

// Re-export React type for helpers
import type React from "react";

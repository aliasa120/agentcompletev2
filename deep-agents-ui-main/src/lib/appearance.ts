// Jan's accent-color presets (from jan-main/web-app/src/hooks/useInterfaceSettings.ts)
// Each preset sets --primary and --sidebar (light/dark variants) at runtime.

export type AccentValue =
  | "gray" | "red" | "orange" | "green" | "emerald" | "teal"
  | "cyan" | "blue" | "purple" | "pink" | "rose"
  // Vintage accents from "The Archive" theme spec
  | "olive" | "terracotta" | "gold" | "dusty-blue";

export interface AccentPreset {
  name: string;
  value: AccentValue;
  thumb: string;
  primary: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { name: "Gray",    value: "gray",    thumb: "#3F3F46", primary: "#52525B" },
  { name: "Red",     value: "red",     thumb: "#F0614B", primary: "#F0614B" },
  { name: "Orange",  value: "orange",  thumb: "#E9A23F", primary: "#E9A23F" },
  { name: "Green",   value: "green",   thumb: "#88BA42", primary: "#88BA42" },
  { name: "Emerald", value: "emerald", thumb: "#38AB51", primary: "#38AB51" },
  { name: "Teal",    value: "teal",    thumb: "#38AB8D", primary: "#38AB8D" },
  { name: "Cyan",    value: "cyan",    thumb: "#45BBDE", primary: "#45BBDE" },
  { name: "Blue",    value: "blue",    thumb: "#456BDE", primary: "#456BDE" },
  { name: "Purple",  value: "purple",  thumb: "#865EEA", primary: "#865EEA" },
  { name: "Pink",    value: "pink",    thumb: "#D55EF3", primary: "#D55EF3" },
  { name: "Rose",    value: "rose",    thumb: "#F655B8", primary: "#F655B8" },
  // ── Vintage accents (from "The Archive" theme) — work in both themes ──
  { name: "Olive",      value: "olive",      thumb: "#73785A", primary: "#73785A" },
  { name: "Terracotta", value: "terracotta", thumb: "#A75D46", primary: "#A75D46" },
  { name: "Gold",       value: "gold",       thumb: "#B08A45", primary: "#B08A45" },
  { name: "Dusty Blue", value: "dusty-blue", thumb: "#6F7D7C", primary: "#6F7D7C" },
];

export const DEFAULT_ACCENT: AccentValue = "gray";
export const FONT_SIZES = [12, 13, 14, 16, 18] as const;
export const DEFAULT_FONT_SIZE = 14;

export function getAccentPreset(value: AccentValue): AccentPreset {
  return ACCENT_PRESETS.find((p) => p.value === value) ?? ACCENT_PRESETS[0];
}

// ─── Theme Variants (base theme) ─────────────────────────────────────────────
// Theme 1 = "modern"  → current black/white base theme
// Theme 2 = "archive" → vintage editorial theme ("The Archive")
// Accent colors stay shared/selectable across BOTH themes (they set --primary).

export type ThemeVariant = "modern" | "archive";

export interface ThemeVariantMeta {
  name: string;
  value: ThemeVariant;
  description: string;
  /** preview swatches for the settings UI */
  preview: { bg: string; surface: string; text: string };
}

export const THEME_VARIANTS: ThemeVariantMeta[] = [
  {
    name: "Modern",
    value: "modern",
    description: "The classic theme — clean black & white base (Theme 1)",
    preview: { bg: "#FFFFFF", surface: "#F4F4F5", text: "#18181B" },
  },
  {
    name: "The Archive",
    value: "archive",
    description: "Vintage editorial theme — aged paper, serif typography (Theme 2)",
    preview: { bg: "#F3EBDD", surface: "#FBF7EF", text: "#3B2A20" },
  },
];

export const DEFAULT_THEME_VARIANT: ThemeVariant = "modern";

// Vintage fonts (Cormorant Garamond headings, Libre Baskerville body, DM Sans
// controls) are loaded from Google Fonts only while the Archive theme is active.
export const ARCHIVE_FONTS_ID = "archive-fonts";
export const ARCHIVE_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=DM+Sans:wght@500;600;700&display=swap";

export function ensureArchiveFonts() {
  if (typeof document === "undefined") return;
  if (document.getElementById(ARCHIVE_FONTS_ID)) return;
  const link = document.createElement("link");
  link.id = ARCHIVE_FONTS_ID;
  link.rel = "stylesheet";
  link.href = ARCHIVE_FONTS_HREF;
  document.head.appendChild(link);
}

export interface AppearanceSettings {
  theme_variant: ThemeVariant;
  accent: AccentValue;
  font_size: number;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme_variant: DEFAULT_THEME_VARIANT,
  accent: DEFAULT_ACCENT,
  font_size: DEFAULT_FONT_SIZE,
};

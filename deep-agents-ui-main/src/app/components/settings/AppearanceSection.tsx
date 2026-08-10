"use client";

import { useTheme } from "@/providers/ThemeProvider";
import { useAppearance } from "@/providers/AppearanceProvider";
import { ACCENT_PRESETS, FONT_SIZES, THEME_VARIANTS } from "@/lib/appearance";
import { JanCard, CardItem } from "@/components/settings/JanCard";
import { Sun, Moon, Monitor, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const { themeVariant, accent, fontSize, setThemeVariant, setAccent, setFontSize } = useAppearance();

  return (
    <div className="space-y-6">
      {/* ── Theme ── */}
      <JanCard title="Theme">
        <CardItem
          title="Interface theme"
          description="Select or sync with your system's color scheme"
          actions={
            <div className="flex gap-2">
              {(
                [
                  { value: "light", icon: Sun, label: "Light" },
                  { value: "dark", icon: Moon, label: "Dark" },
                  { value: "system", icon: Monitor, label: "System" },
                ] as const
              ).map(({ value, icon: Icon, label }) => (
                <button
                  key={value}
                  onClick={() => setTheme(value)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border",
                    theme === value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
          }
        />
      </JanCard>

      {/* ── Theme Style (Theme 1 / Theme 2) ── */}
      <JanCard title="Theme Style">
        <CardItem
          column
          title="Base theme"
          description="Switch between the default modern theme and the vintage Archive theme. Layout stays the same — only base colors and typography change. Accent colors are shared across both themes"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            {THEME_VARIANTS.map((variant) => (
              <button
                key={variant.value}
                onClick={() => setThemeVariant(variant.value)}
                className={cn(
                  "relative flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors",
                  themeVariant === variant.value
                    ? "border-primary ring-1 ring-primary"
                    : "border-border hover:border-primary/50"
                )}
              >
                {/* Mini preview swatch */}
                <div
                  className="h-14 w-full rounded-md border overflow-hidden flex"
                  style={{ backgroundColor: variant.preview.bg, borderColor: "var(--border)" }}
                >
                  <div className="flex-1 flex flex-col justify-center gap-1.5 px-3">
                    <div
                      className="h-1.5 w-2/3 rounded-full"
                      style={{ backgroundColor: variant.preview.text }}
                    />
                    <div
                      className="h-1.5 w-1/3 rounded-full opacity-50"
                      style={{ backgroundColor: variant.preview.text }}
                    />
                  </div>
                  <div
                    className="w-1/3"
                    style={{ backgroundColor: variant.preview.surface }}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">{variant.name}</span>
                  {themeVariant === variant.value && (
                    <Check className="h-3.5 w-3.5 text-primary" />
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground leading-snug">
                  {variant.description}
                </span>
              </button>
            ))}
          </div>
        </CardItem>
      </JanCard>

      {/* ── Accent Color ── */}
      <JanCard title="Accent Color">
        <CardItem
          column
          title="Accent"
          description="Sets the secondary accent color across buttons, active states, and interactive controls"
        >
          <div className="grid grid-cols-5 gap-2.5 mt-3">
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset.value}
                onClick={() => setAccent(preset.value)}
                title={preset.name}
                className={cn(
                  "relative flex flex-col items-center gap-1 group"
                )}
              >
                <div
                  className={cn(
                    "h-8 w-8 rounded-full transition-transform group-hover:scale-110",
                    accent === preset.value && "ring-2 ring-offset-2 ring-foreground"
                  )}
                  style={{ backgroundColor: preset.thumb }}
                >
                  {accent === preset.value && (
                    <div className="h-full w-full flex items-center justify-center">
                      <Check className="h-4 w-4 text-white" />
                    </div>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {preset.name}
                </span>
              </button>
            ))}
          </div>
        </CardItem>
      </JanCard>

      {/* ── Font Size ── */}
      <JanCard title="Font Size">
        <CardItem
          title="Interface font size"
          description="Adjust the base font size across the entire app"
          actions={
            <div className="flex items-center gap-2">
              {FONT_SIZES.map((size) => (
                <button
                  key={size}
                  onClick={() => setFontSize(size)}
                  className={cn(
                    "h-8 min-w-[2.5rem] rounded-lg text-xs font-medium border transition-colors",
                    fontSize === size
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                  )}
                >
                  {size}px
                </button>
              ))}
            </div>
          }
        />
      </JanCard>
    </div>
  );
}

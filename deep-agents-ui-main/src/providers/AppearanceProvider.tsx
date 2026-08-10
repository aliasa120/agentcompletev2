"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  DEFAULT_APPEARANCE,
  AppearanceSettings,
  AccentValue,
  ThemeVariant,
  getAccentPreset,
  ensureArchiveFonts,
} from "@/lib/appearance";
import { useTheme } from "@/providers/ThemeProvider";

interface AppearanceContextType {
  themeVariant: ThemeVariant;
  accent: AccentValue;
  fontSize: number;
  setThemeVariant: (variant: ThemeVariant) => void;
  setAccent: (accent: AccentValue) => void;
  setFontSize: (px: number) => void;
}

const AppearanceContext = createContext<AppearanceContextType | undefined>(undefined);

const APPEARANCE_STORAGE_KEY = "appearance";

function applyAccentToDOM(accent: AccentValue) {
  const preset = getAccentPreset(accent);
  const root = document.documentElement;
  root.style.setProperty("--primary", preset.primary);
  root.style.setProperty("--sidebar-primary", preset.primary);
  root.style.removeProperty("--sidebar");
}

function applyVariantToDOM(variant: ThemeVariant) {
  const root = document.documentElement;
  root.classList.toggle("archive", variant === "archive");
  if (variant === "archive") ensureArchiveFonts();
}

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  const [settings, setSettings] = useState<AppearanceSettings>(DEFAULT_APPEARANCE);
  const [isLoaded, setIsLoaded] = useState(false);

    // Load from localStorage first (fast), then sync from DB
    useEffect(() => {
      try {
        const saved = localStorage.getItem(APPEARANCE_STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed?.accent || parsed?.theme_variant) {
            setSettings({ ...DEFAULT_APPEARANCE, ...parsed });
          }
        }
      } catch {}
    setIsLoaded(true);

    // Fetch from DB (overrides localStorage if present)
    fetch("/api/user-settings")
      .then((res) => res.json())
      .then((data) => {
        if (data?.settings?.appearance) {
          const dbAppearance = data.settings.appearance;
          if (dbAppearance.accent || dbAppearance.font_size) {
            const merged = { ...DEFAULT_APPEARANCE, ...dbAppearance };
            setSettings(merged);
            localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(merged));
          }
        }
      })
      .catch(() => {});
  }, []);

  // Apply to DOM whenever settings or theme change
  useEffect(() => {
    applyVariantToDOM(settings.theme_variant);
    applyAccentToDOM(settings.accent);
    document.documentElement.style.setProperty("--font-size-base-px", String(settings.font_size));
  }, [settings, theme]);

  const saveToDb = (updated: AppearanceSettings) => {
    fetch("/api/user-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appearance: updated }),
    }).catch(() => {
      toast.error("Appearance settings could not be saved to your account.");
    });
  };

  const setThemeVariant = (theme_variant: ThemeVariant) => {
    const updated = { ...settings, theme_variant };
    setSettings(updated);
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(updated));
    saveToDb(updated);
  };

  const setAccent = (accent: AccentValue) => {
    const updated = { ...settings, accent };
    setSettings(updated);
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(updated));
    saveToDb(updated);
  };

  const setFontSize = (px: number) => {
    const updated = { ...settings, font_size: px };
    setSettings(updated);
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(updated));
    saveToDb(updated);
  };

  return (
    <AppearanceContext.Provider
      value={{
        themeVariant: settings.theme_variant,
        accent: settings.accent,
        fontSize: settings.font_size,
        setThemeVariant,
        setAccent,
        setFontSize,
      }}
    >
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance() {
  const ctx = useContext(AppearanceContext);
  if (ctx === undefined) {
    throw new Error("useAppearance must be used within AppearanceProvider");
  }
  return ctx;
}

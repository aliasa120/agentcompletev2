import { NuqsAdapter } from "nuqs/adapters/next/app";
import { Toaster } from "sonner";
import "./globals.css";
import { CronHeartbeat } from "@/app/components/CronHeartbeat";
import { ThemeProvider } from "@/providers/ThemeProvider";
import { AppearanceProvider } from "@/providers/AppearanceProvider";

// Force all pages to be server-rendered on demand (not statically pre-built)
// This prevents Supabase/API calls from running during Docker build
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  const savedTheme = localStorage.getItem('theme') || 'system';
                  const isDark = savedTheme === 'dark' || (savedTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
                  if (isDark) {
                    document.documentElement.classList.add('dark');
                  } else {
                    document.documentElement.classList.remove('dark');
                  }
                  const appearance = JSON.parse(localStorage.getItem('appearance') || 'null');
                  if (appearance && appearance.theme_variant === 'archive') {
                    document.documentElement.classList.add('archive');
                    if (!document.getElementById('archive-fonts')) {
                      var fontLink = document.createElement('link');
                      fontLink.id = 'archive-fonts';
                      fontLink.rel = 'stylesheet';
                      fontLink.href = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=DM+Sans:wght@500;600;700&display=swap';
                      document.head.appendChild(fontLink);
                    }
                  }
                  if (appearance && appearance.accent) {
                    const ACCENTS = {
                      gray:    { primary: '#52525B' },
                      red:     { primary: '#F0614B' },
                      orange:  { primary: '#E9A23F' },
                      green:   { primary: '#88BA42' },
                      emerald: { primary: '#38AB51' },
                      teal:    { primary: '#38AB8D' },
                      cyan:    { primary: '#45BBDE' },
                      blue:    { primary: '#456BDE' },
                      purple:  { primary: '#865EEA' },
                      pink:    { primary: '#D55EF3' },
                      rose:    { primary: '#F655B8' },
                      olive:      { primary: '#73785A' },
                      terracotta: { primary: '#A75D46' },
                      gold:       { primary: '#B08A45' },
                      'dusty-blue': { primary: '#6F7D7C' },
                    };
                    const a = ACCENTS[appearance.accent] || ACCENTS.gray;
                    const root = document.documentElement;
                    root.style.setProperty('--primary', a.primary);
                    root.style.setProperty('--sidebar-primary', a.primary);
                  }
                  if (appearance && appearance.font_size) {
                    document.documentElement.style.setProperty('--font-size-base-px', appearance.font_size);
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body
        suppressHydrationWarning
      >
        <ThemeProvider>
          <AppearanceProvider>
            <CronHeartbeat />
            <NuqsAdapter>{children}</NuqsAdapter>
            <Toaster />
          </AppearanceProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}


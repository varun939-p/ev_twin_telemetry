import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";

import "./globals.css";

/**
 * Type system — two technical faces, VENDORED into `app/fonts` and served by
 * `next/font/local`:
 *
 *   Inter          UI copy, labels, prose.  Tall x-height, unambiguous 1/l/I.
 *   JetBrains Mono every telemetry number.  True tabular figures + slashed
 *                  zero, so a column of SOC values cannot shift between ticks.
 *
 * Deliberately NOT `next/font/google`: that fetches from fonts.googleapis.com
 * at BUILD time, which fails on an air-gapped CI runner and would block a
 * release the morning of a demo. The variable `.woff2` files come from the
 * `@fontsource-variable/*` packages (SIL Open Font License) and cover 100–900
 * in a single axis-variable file each, ~48 KB and ~40 KB.
 *
 * Both are exposed as CSS variables and wired to Tailwind's `font-sans` /
 * `font-mono` in globals.css.
 */
const inter = localFont({
  src: "./fonts/Inter-Variable.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-inter",
  display: "swap",
  fallback: ["system-ui", "Segoe UI", "Helvetica Neue", "Arial", "sans-serif"],
});

const jetbrains = localFont({
  src: "./fonts/JetBrainsMono-Variable.woff2",
  weight: "100 800",
  style: "normal",
  variable: "--font-jetbrains",
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});


export const metadata: Metadata = {
  title: { default: "Digital Twin — Twin Ops", template: "%s · Digital Twin" },
  description:
    "Proprietary EV battery-swap digital twin. Renders only telemetry that has passed the backend validation gates.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${jetbrains.variable}`}>
      <head>
        {/* Paints the persisted theme before hydration — no white flash, and
            React's tree is identical on both sides of the boundary. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}

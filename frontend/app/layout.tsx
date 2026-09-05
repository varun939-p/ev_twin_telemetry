import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";

import "./globals.css";

/**
 * Type system — three faces, VENDORED into `app/fonts` and served by
 * `next/font/local`:
 *
 *   IBM Plex Sans   UI copy, labels, table text. An IBM-commissioned
 *                   corporate/engineering face: neutral, slightly condensed,
 *                   unambiguous 1/l/I, and it holds up at 11-12 px in a dense
 *                   register where a geometric grotesk turns to mush.
 *   Space Grotesk   Display only — page headings and the large KPI numerals.
 *                   Its tighter apertures and distinctive digits give the
 *                   dashboard a deliberate identity instead of the default
 *                   Inter-everywhere look.
 *   JetBrains Mono  Every telemetry value. True tabular figures + slashed
 *                   zero, so a column of SOC readings cannot shift between
 *                   ticks.
 *
 * Deliberately NOT `next/font/google`: that fetches from fonts.googleapis.com
 * at BUILD time, which fails on an air-gapped CI runner and would block a
 * release the morning of a demo. These `.woff2` files come from the
 * `@fontsource*` packages (SIL Open Font License), copied in at build-prep
 * time so the repo has no runtime font dependency at all.
 *
 * Plex ships as four static weights rather than a variable axis; that is
 * intentional. The UI only ever uses 400/500/600/700, and four subsetted
 * static files (~23 KB each, and only the ones a page needs are fetched) beat
 * shipping a full variable axis nobody interpolates across.
 */
const plex = localFont({
  src: [
    { path: "./fonts/IBMPlexSans-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/IBMPlexSans-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/IBMPlexSans-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/IBMPlexSans-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-plex",
  display: "swap",
  fallback: ["system-ui", "Segoe UI", "Helvetica Neue", "Arial", "sans-serif"],
});

const grotesk = localFont({
  src: "./fonts/SpaceGrotesk-Variable.woff2",
  weight: "300 700",
  style: "normal",
  variable: "--font-grotesk",
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
    <html lang="en" suppressHydrationWarning className={`${plex.variable} ${grotesk.variable} ${jetbrains.variable}`}>
      <head>
        {/* Paints the persisted theme before hydration — no white flash, and
            React's tree is identical on both sides of the boundary. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}

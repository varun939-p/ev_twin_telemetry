import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

import "./globals.css";

/**
 * Type system — Geist + Geist Mono, VENDORED into `app/fonts` and served by
 * `next/font/local`.
 *
 *   Geist       headings, KPI numerals, UI copy and table text. One variable
 *               axis (100–900) covers display and body weights, so the whole
 *               interface is a single 29 KB download instead of two families.
 *   Geist Mono  every telemetry value. Real tabular figures and a slashed
 *               zero, so a column of SOC readings cannot shift between ticks.
 *
 * Deliberately NOT `next/font/google`: that fetches from fonts.googleapis.com
 * at BUILD time, which fails on an air-gapped CI runner and would block a
 * release the morning of a demo. The `.woff2` files come from the
 * `@fontsource-variable/*` packages (SIL Open Font License) and are copied in
 * at build-prep time, so the repo has no runtime font dependency at all.
 */
const geist = localFont({
  src: "./fonts/Geist-Variable.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-geist",
  display: "swap",
  fallback: ["system-ui", "Segoe UI", "Helvetica Neue", "Arial", "sans-serif"],
});

const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-geist-mono",
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
    <html lang="en" suppressHydrationWarning className={`${geist.variable} ${geistMono.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}

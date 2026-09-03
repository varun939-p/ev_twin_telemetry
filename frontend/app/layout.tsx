import type { Metadata } from "next";
import type { ReactNode } from "react";

import Providers from "@/components/telemetry/Providers";

import "./globals.css";

export const metadata: Metadata = {
  title: "Digital Twin — Real-Time Asset Layer",
  description:
    "EV battery swap station digital twin. Renders only telemetry that has passed the backend validation gates.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-950 font-sans text-slate-100">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

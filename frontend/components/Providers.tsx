"use client";

import { FilterProvider } from "@/lib/FilterContext";

/** Root client providers. Mounted in `app/layout.tsx` so filter state persists
 *  across the Fleet Twin, Trucks and Batteries views. */
export default function Providers({ children }: { children: React.ReactNode }) {
  return <FilterProvider>{children}</FilterProvider>;
}

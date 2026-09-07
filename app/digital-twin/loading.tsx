export default function DigitalTwinLoading() {
  return (
    <div className="space-y-4" aria-label="Loading dashboard" aria-live="polite">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <div className="h-6 w-48 animate-pulse rounded-md bg-surface-3" />
          <div className="h-3 w-72 max-w-full animate-pulse rounded bg-surface-3" />
        </div>
        <div className="h-8 w-32 animate-pulse rounded-lg bg-surface-3" />
      </div>
      <div className="h-[420px] animate-pulse rounded-xl border border-line bg-surface" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((item) => (
          <div key={item} className="h-28 animate-pulse rounded-xl border border-line bg-surface" />
        ))}
      </div>
    </div>
  );
}

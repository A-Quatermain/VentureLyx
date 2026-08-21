// No default radius/background — string-concatenated Tailwind classes
// don't reliably override each other by append order (CSS cascade order
// depends on how Tailwind compiles them, not class-attribute order), so a
// hardcoded default here could silently "win" over a caller's override.
// Every caller specifies its own.
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse ${className}`} />;
}

export function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Skeleton className="h-[34px] w-[34px] rounded-full bg-muted" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-2/3 rounded-md bg-muted" />
        <Skeleton className="h-3 w-1/3 rounded-md bg-muted" />
      </div>
      <Skeleton className="h-4 w-12 rounded-md bg-muted" />
    </div>
  );
}

export function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}

// A sweeping highlight rather than a uniform pulse — foreground/10 reads as a
// faint light streak on dark muted backgrounds and a faint dark streak on
// light ones, so it works in both themes without a light/dark branch.
export function ShimmerBlock({ className = '' }: { className?: string }) {
  return (
    <div className={`relative overflow-hidden bg-muted ${className}`}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-foreground/10 to-transparent" />
    </div>
  );
}

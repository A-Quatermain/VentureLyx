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
      <Skeleton className="h-[34px] w-[34px] rounded-none bg-muted" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-2/3 rounded-none bg-muted" />
        <Skeleton className="h-3 w-1/3 rounded-none bg-muted" />
      </div>
      <Skeleton className="h-4 w-12 rounded-none bg-muted" />
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

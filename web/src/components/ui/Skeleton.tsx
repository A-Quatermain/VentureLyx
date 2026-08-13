export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-button bg-line-2 ${className}`} />;
}

export function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Skeleton className="h-[34px] w-[34px] rounded-button" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <Skeleton className="h-4 w-12" />
    </div>
  );
}

export function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="divide-y divide-line-2">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}

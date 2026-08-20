'use client';

import { ArrowClockwise } from '@phosphor-icons/react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

// Catches errors thrown while rendering a page inside (app) — AppShell
// (the sidebar/topbar, defined in this segment's layout.tsx) keeps
// rendering around this, so a broken page doesn't take the whole shell
// down with it. Root-layout-level failures still fall through to
// app/global-error.tsx, which this can't reach.
export default function AppSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <Card className="w-full max-w-sm p-8 text-center">
        <p className="font-display text-lg font-black tracking-tight">Something went wrong</p>
        <p className="mt-2 text-sm text-muted-foreground">
          This page hit an unexpected error — often a moment of network trouble. Nothing was lost.
        </p>
        <Button onClick={() => reset()} className="mt-6 inline-flex items-center gap-1.5">
          <ArrowClockwise size={14} weight="bold" /> Try again
        </Button>
        {error.digest && <p className="mt-4 font-mono text-xs text-muted-foreground/70">Ref: {error.digest}</p>}
      </Card>
    </div>
  );
}

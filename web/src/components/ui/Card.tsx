import { type HTMLAttributes } from 'react';

// Swiss Brutalist: flat, 1px border, no shadow — "the content defines the
// card, not the container." No default padding: Tailwind's own spacing
// scale compiles p-0 BEFORE p-4 in the generated stylesheet (numeric scale
// order, not declaration order), so a hardcoded `p-4` base class would
// always beat a caller's `p-0` override at equal specificity — the
// "flush" cards across this app were silently not flush. Every caller
// specifies its own padding now.
export function Card({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`border border-border bg-surface ${className}`} {...props} />;
}

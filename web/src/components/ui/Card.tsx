import { type HTMLAttributes } from 'react';

// White, rounded, soft shadow — docs/design_guidelines.json. No default
// padding: Tailwind's own spacing scale compiles p-0 BEFORE p-4 in the
// generated stylesheet (numeric scale order, not declaration order), so a
// hardcoded `p-4` base class would always beat a caller's `p-0` override at
// equal specificity. Every caller specifies its own padding.
export function Card({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-xl border border-border bg-surface shadow-sm transition-shadow duration-200 hover:shadow-md ${className}`}
      {...props}
    />
  );
}

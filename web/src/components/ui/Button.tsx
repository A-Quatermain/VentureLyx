import { type ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'attention' | 'ghost';
}

// design_guidelines.json: primary (Klein Blue) is reserved for critical
// conversions/CTAs — there's no separate "amber attention" tier in this
// system the way Daylight Ledger had one, so `attention` maps to
// destructive instead (unused anywhere currently, kept for a future
// urgent/destructive-toned CTA rather than removed outright).
const variants: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-primary text-primary-foreground hover:opacity-90',
  attention: 'bg-destructive text-destructive-foreground hover:opacity-90',
  ghost: 'bg-transparent text-foreground border border-border hover:bg-muted',
};

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  return (
    <button
      className={`min-h-[42px] rounded-none px-4 text-sm font-medium transition-opacity disabled:opacity-50 ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

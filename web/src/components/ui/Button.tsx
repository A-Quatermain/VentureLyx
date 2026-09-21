import { type ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ai' | 'attention' | 'ghost';
}

// docs/design_guidelines.json: 'ai' is the recurring "Fix this for me"
// gradient CTA — the one place the brand's blue-to-teal gradient appears,
// consistently, everywhere an AI action is on offer.
const variants: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover hover:shadow-md',
  ai: 'bg-gradient-to-r from-primary to-accent-deep text-white shadow-sm hover:shadow-md',
  attention: 'bg-destructive text-destructive-foreground shadow-sm hover:opacity-90',
  ghost: 'bg-transparent text-foreground border border-border hover:bg-muted',
};

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  return (
    <button
      className={`min-h-[42px] rounded-lg px-4 text-sm font-medium transition-[background-color,box-shadow] duration-200 disabled:opacity-50 ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

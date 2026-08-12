import { type ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'attention' | 'ghost';
}

const variants: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-pool text-white hover:opacity-90',
  attention: 'bg-sun text-white hover:opacity-90',
  ghost: 'bg-transparent text-ink border border-line-2 hover:bg-card-sunk',
};

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  return (
    <button
      className={`min-h-[42px] rounded-button px-4 text-sm font-medium transition-opacity disabled:opacity-50 ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

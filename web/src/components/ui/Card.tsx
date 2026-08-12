import { type HTMLAttributes } from 'react';

export function Card({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-card border border-line-2 bg-card p-4 shadow-card ${className}`}
      {...props}
    />
  );
}

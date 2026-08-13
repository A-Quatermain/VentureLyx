// Minimal hand-rolled stroke icons — no icon library dependency, matches
// "no decorative chrome." 18x18, currentColor, 1.75 stroke.
import type { SVGProps } from 'react';

const base = { viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export function IconDollar(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M9 2v14M12.5 5.5c0-1.4-1.6-2.5-3.5-2.5S5.5 4.1 5.5 5.5 7 7.5 9 8s3.5 1.1 3.5 2.5-1.6 2.5-3.5 2.5-3.5-1.1-3.5-2.5" />
    </svg>
  );
}

export function IconAlertTriangle(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M9 2.5 16 15H2L9 2.5Z" />
      <path d="M9 7.5v3.2M9 13v.01" />
    </svg>
  );
}

export function IconCalendar(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="2.5" y="3.5" width="13" height="12" rx="1.5" />
      <path d="M2.5 7h13M6 2v3M12 2v3" />
    </svg>
  );
}

export function IconStar(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M9 2.5 11.2 7l5 .7-3.6 3.4.9 4.9L9 13.6l-4.5 2.4.9-4.9L1.8 7.7l5-.7L9 2.5Z" />
    </svg>
  );
}

export function IconTrendUp(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M2.5 13.5 8 8l3 3 4.5-4.5" />
      <path d="M12 6h3.5v3.5" />
    </svg>
  );
}

export function IconMail(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="2" y="4" width="14" height="10" rx="1.5" />
      <path d="m2.5 5 6.5 5 6.5-5" />
    </svg>
  );
}

export function IconClock(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="9" cy="9" r="6.5" />
      <path d="M9 5.5V9l2.5 1.5" />
    </svg>
  );
}

export function IconUsers(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="6.5" cy="6" r="2.5" />
      <path d="M2 15c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" />
      <path d="M11.5 3.6c1.1.3 2 1.3 2 2.6s-.9 2.3-2 2.6M13.5 11.3c1.7.4 3 1.7 3 3.7" />
    </svg>
  );
}

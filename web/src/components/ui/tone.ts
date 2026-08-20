// Swiss Brutalist semantic tones. design_guidelines.json's palette has no
// dedicated "amber/warning" tier the way Daylight Ledger did — primary
// (Klein Blue) is explicitly reserved for "critical actions," so it also
// covers the "needs attention, not yet critical" middle tier here.
export type Tone = 'primary' | 'muted' | 'destructive' | 'success';

export const toneSoft: Record<Tone, string> = {
  primary: 'bg-primary/10 text-primary',
  muted: 'bg-muted text-muted-foreground',
  destructive: 'bg-destructive/10 text-destructive',
  success: 'bg-success/10 text-success',
};

export const toneFill: Record<Tone, string> = {
  primary: 'bg-primary',
  muted: 'bg-muted-foreground',
  destructive: 'bg-destructive',
  success: 'bg-success',
};

// Outlined tag style — border + text, no fill. Matches ref-1's PRIORITY
// badge treatment (CommandCenter.jsx) exactly.
export const toneOutline: Record<Tone, string> = {
  primary: 'border-primary text-primary',
  muted: 'border-border text-muted-foreground',
  destructive: 'border-destructive text-destructive',
  success: 'border-success text-success',
};

export function healthTone(score: number): Tone {
  if (score >= 80) return 'success';
  if (score >= 50) return 'primary';
  return 'destructive';
}

export function severityTone(severity: 'critical' | 'high' | 'medium' | 'low'): Tone {
  if (severity === 'critical' || severity === 'high') return 'destructive';
  if (severity === 'medium') return 'primary';
  return 'muted';
}

// signals.severity is a smallint, lower = more severe (1/2 ~ critical/high,
// 3 ~ medium, 4+ ~ low) — not the same scale as severityTone's text enum
// above, which is seo_issues' column specifically.
export function signalSeverityTone(severity: number): Tone {
  if (severity <= 2) return 'destructive';
  if (severity === 3) return 'primary';
  return 'muted';
}

export function signalSeverityLabel(severity: number): 'high' | 'medium' | 'low' {
  if (severity <= 2) return 'high';
  if (severity === 3) return 'medium';
  return 'low';
}

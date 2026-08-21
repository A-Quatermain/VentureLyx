// Indigo/violet semantic tones (docs/design_guidelines.json). Unlike the
// earlier Swiss Brutalist palette, this one has a dedicated warning/amber
// tier — primary (indigo) is the brand action color, not a stand-in for
// "needs attention, not yet critical" anymore, so that middle tier now maps
// to warning instead.
export type Tone = 'primary' | 'muted' | 'destructive' | 'success' | 'warning';

export const toneSoft: Record<Tone, string> = {
  primary: 'bg-primary/10 text-primary',
  muted: 'bg-muted text-muted-foreground',
  destructive: 'bg-destructive/10 text-destructive',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
};

export const toneFill: Record<Tone, string> = {
  primary: 'bg-primary',
  muted: 'bg-muted-foreground',
  destructive: 'bg-destructive',
  success: 'bg-success',
  warning: 'bg-warning',
};

// Outlined pill/chip style — border + text, no fill.
export const toneOutline: Record<Tone, string> = {
  primary: 'border-primary text-primary',
  muted: 'border-border text-muted-foreground',
  destructive: 'border-destructive text-destructive',
  success: 'border-success text-success',
  warning: 'border-warning text-warning',
};

export function healthTone(score: number): Tone {
  if (score >= 80) return 'success';
  if (score >= 50) return 'warning';
  return 'destructive';
}

export function severityTone(severity: 'critical' | 'high' | 'medium' | 'low'): Tone {
  if (severity === 'critical' || severity === 'high') return 'destructive';
  if (severity === 'medium') return 'warning';
  return 'muted';
}

// signals.severity is a smallint, lower = more severe (1/2 ~ critical/high,
// 3 ~ medium, 4+ ~ low) — not the same scale as severityTone's text enum
// above, which is seo_issues' column specifically.
export function signalSeverityTone(severity: number): Tone {
  if (severity <= 2) return 'destructive';
  if (severity === 3) return 'warning';
  return 'muted';
}

export function signalSeverityLabel(severity: number): 'high' | 'medium' | 'low' {
  if (severity <= 2) return 'high';
  if (severity === 3) return 'medium';
  return 'low';
}

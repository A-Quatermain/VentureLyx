export type Tone = 'pool' | 'sun' | 'growth' | 'alert' | 'ink';

export const toneSoft: Record<Tone, string> = {
  pool: 'bg-pool-soft text-pool',
  sun: 'bg-sun-soft text-sun',
  growth: 'bg-growth-soft text-growth',
  alert: 'bg-alert-soft text-alert',
  ink: 'bg-line-2 text-ink-2',
};

export const toneFill: Record<Tone, string> = {
  pool: 'bg-pool',
  sun: 'bg-sun',
  growth: 'bg-growth',
  alert: 'bg-alert',
  ink: 'bg-ink-3',
};

export type HealthTone = 'growth' | 'sun' | 'alert';

export function healthTone(score: number): HealthTone {
  if (score >= 80) return 'growth';
  if (score >= 50) return 'sun';
  return 'alert';
}

export function severityTone(severity: 'critical' | 'high' | 'medium' | 'low'): Tone {
  if (severity === 'critical' || severity === 'high') return 'alert';
  if (severity === 'medium') return 'sun';
  return 'ink';
}

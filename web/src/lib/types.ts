export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: string;
  modules: unknown;
}

export interface MeResponse {
  authenticated: boolean;
  mfaSatisfied?: boolean;
  user?: {
    id: string;
    email: string;
    name: string;
    isStaff: boolean;
  };
  currentOrgId?: string | null;
  role?: string | null;
  organizations?: Organization[];
}

export interface LoginResponse {
  mfaRequired: boolean;
  orgId: string | null;
  needsOrgChoice: boolean;
}

// ---- GET /command/summary --------------------------------------------------
export interface Opportunity {
  id: string;
  title: string;
  rationale: string;
  est_value_monthly: string | null;
  effort: string | null;
  confidence: string | null;
  score: string | null;
  kind: string;
  module: string;
}

export interface MoneyChannel {
  channel: string;
  amount: string;
}

export interface SeoSummary {
  health: number | null;
  technical: number | null;
  content: number | null;
  performance: number | null;
  local_seo: number | null;
  pages: number | null;
  broken_links: number | null;
  critical_issues: number | null;
  high_issues: number | null;
  computed_at: string | null;
  site_key: string | null;
  site_url: string | null;
}

export interface SummaryResponse {
  org: { name: string; vertical: string | null; modules: unknown };
  money: { collected: string; outstanding: string; last_month: string };
  channels: MoneyChannel[];
  opportunities: Opportunity[];
  seo: SeoSummary | null;
  leads: { new_leads: number; stale: number };
  work: { today_total: number; today_done: number; week: number };
}

// ---- GET /command/signals ---------------------------------------------------
export type SignalSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Signal {
  id: string;
  module: string;
  signal_type: string;
  severity: SignalSeverity;
  summary: string;
  detail: string | null;
  detected_at: string;
}

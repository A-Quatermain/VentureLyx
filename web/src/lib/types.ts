export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: string;
  modules: unknown;
  health: number | null;
  siteCount: number;
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

// ---- ScaleSEO ----------------------------------------------------------------
export interface SeoSite {
  id: string;
  key: string;
  name: string;
  url: string;
  enabled: boolean;
  render: boolean;
  max_pages: number;
  last_crawl_at: string | null;
  next_crawl_at: string | null;
  crawl_schedule: string | null;
  health: number | null;
  pages: number | null;
  critical_issues: number | null;
  high_issues: number | null;
}

export interface SeoScoreDetail {
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
  started_at: string | null;
  pages_crawled: number | null;
  crawl_status: string | null;
}

export interface SeoIssueGroup {
  code: string;
  severity: SignalSeverity;
  auto_fixable: boolean;
  pages: number;
  examples: string[];
  example_detail: string | null;
}

export interface SeoTrendPoint {
  health: number | null;
  computed_at: string;
}

export interface SeoHealthDetail {
  // q.one() returns null when the site has no crawl yet (new site, or a
  // crawl that hasn't completed) — not a hypothetical, seo_scores simply
  // has no matching row until the first crawl finishes.
  score: SeoScoreDetail | null;
  issues: SeoIssueGroup[];
  trend: SeoTrendPoint[];
}

export interface SeoPage {
  url: string;
  status_code: number;
  title: string | null;
  title_len: number | null;
  meta_desc_len: number | null;
  h1_count: number | null;
  word_count: number | null;
  images_total: number | null;
  images_no_alt: number | null;
  response_ms: number | null;
  indexable: boolean;
  schema_types: unknown;
}

export interface CrawlResponse {
  queued: boolean;
  jobId?: number;
  reason?: string;
}

export interface SeoRanking {
  phrase: string;
  location_name: string;
  position: number | null;
  previous: number | null;
  movement: number | null;
  checked_on: string;
}

// ---- Operate -------------------------------------------------------------
export interface Lead {
  id: string;
  display_name: string;
  lifecycle: string;
  city: string | null;
  last_activity_at: string | null;
  first_seen_at: string;
  channel: string | null;
  source: string | null;
  phone: string | null;
}

export interface OverdueInvoice {
  number: string;
  total: string;
  owed: string;
  due_on: string;
  display_name: string;
  days_overdue: number;
}

export interface OperateMoneyResponse {
  overdue: OverdueInvoice[];
  upcoming: { count: number; total: string };
}

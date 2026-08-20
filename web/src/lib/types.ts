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

export interface CreateOrgResponse {
  id: string;
  name: string;
  slug: string;
  siteId: string | null;
  crawlQueued: boolean;
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
// seo_issues.severity (used below by SeoIssueGroup) is a real `text` column
// with these four values. signals.severity is a *different* table — a
// smallint, lower number = more severe — see Signal below; don't reuse this
// type for it.
export type SignalSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Signal {
  id: number;
  module: string;
  signal_type: string;
  severity: number;
  summary: string;
  detail: Record<string, unknown> | null;
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

export type Lifecycle = 'new' | 'working' | 'qualified' | 'customer' | 'lost' | 'dormant';
export type PartyKind = 'person' | 'company';
export type ContactChannel = 'email' | 'phone' | 'sms' | 'whatsapp' | 'url';

export interface PartyListItem {
  id: string;
  display_name: string;
  company_name: string | null;
  lifecycle: Lifecycle;
  city: string | null;
  last_activity_at: string | null;
  first_seen_at: string;
  phone: string | null;
  email: string | null;
  lifetime_value: string;
  open_balance: string;
  first_touch_channel: string | null;
}

export interface PartyContact {
  id: string;
  channel: ContactChannel;
  value: string;
  label: string | null;
  is_primary: boolean;
}

export interface Party {
  id: string;
  kind: PartyKind;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  is_lead: boolean;
  is_customer: boolean;
  is_vendor: boolean;
  lifecycle: Lifecycle;
  city: string | null;
  address_line1: string | null;
  address_line2: string | null;
  region: string | null;
  postal_code: string | null;
  country: string;
  notes: string | null;
  tags: string[];
  first_seen_at: string;
  last_activity_at: string | null;
}

export interface PartyDetail {
  party: Party & {
    first_touch_channel: string | null;
    first_touch_source: string | null;
    first_touch_at: string | null;
  };
  contacts: PartyContact[];
  money: {
    lifetime_value: string;
    open_balance: string;
    last_payment: { amount: string; received_at: string } | null;
  };
}

export interface TimelineEvent {
  id: number;
  event_type: string;
  module: string | null;
  title: string;
  body: string | null;
  actor_type: string;
  actor_label: string | null;
  occurred_at: string;
}

export type CatalogKind = 'service' | 'product' | 'package' | 'fee';

export interface CatalogItem {
  id: string;
  kind: CatalogKind;
  name: string;
  slug: string;
  description: string | null;
  sku: string | null;
  unit: string;
  unit_price: string | null;
  cost: string | null;
  taxable: boolean;
  duration_min: number | null;
  is_active: boolean;
  priority: number;
}

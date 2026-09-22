export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: string;
  modules: unknown;
  health: number | null;
  siteCount: number;
}

// ---- Settings ----------------------------------------------------------
export interface OrgProfile {
  id: string;
  name: string;
  website_url: string | null;
  vertical: string | null;
  service_area: string | null;
}

export type AIFeature =
  | 'seo_recommendations' | 'page_generation' | 'review_response'
  | 'next_best_action' | 'metric_explanation' | 'business_blueprint' | 'sequence_writing';

export type AIProvider = 'anthropic' | 'openai';
export type AIProviderPreference = 'auto' | AIProvider;

export interface KnownModel {
  provider: AIProvider;
  model: string;
  label: string;
}

export interface AIModelOverride {
  provider: AIProvider;
  model: string;
}

export interface AIUsageByFeature {
  calls: number;
  tokens: number;
  estimatedCost: number;
}

export interface AISettingsResponse {
  providerPreference: AIProviderPreference;
  spendCapMonthly: number | null;
  modelOverrides: Partial<Record<AIFeature, AIModelOverride | null>>;
  connectedProviders: AIProvider[];
  hasSharedAnthropic: boolean;
  hasSharedOpenai: boolean;
  knownModels: KnownModel[];
  usageThisMonth: {
    byFeature: Partial<Record<AIFeature, AIUsageByFeature>>;
    totalEstimatedCost: number;
  };
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

export interface PipelineFunnelStage {
  stage: string;
  count: number;
  value: string;
}

export interface SummaryResponse {
  org: { name: string; vertical: string | null; modules: unknown };
  money: { collected: string; outstanding: string; last_month: string };
  channels: MoneyChannel[];
  opportunities: Opportunity[];
  seo: SeoSummary | null;
  leads: { new_leads: number; stale: number };
  work: { today_total: number; today_done: number; week: number };
  pipeline: { pipeline_value: string; open_deals: number };
  reputation: { avg_rating: string | null; review_count: number };
  expenses: { this_month: string };
  pipelineFunnel: PipelineFunnelStage[];
}

export interface RevenueTrendPoint {
  month: string;
  month_key: string;
  amount: string;
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

// ---- GET/PATCH /seo/sites/:siteId — crawler config, not health ------------
export interface SeoSiteConfig {
  id: string;
  key: string;
  name: string;
  url: string;
  enabled: boolean;
  render: boolean;
  max_pages: number;
  concurrency: number;
  delay_ms: number;
  timeout_s: number;
  respect_robots: boolean;
  crawl_schedule: string | null;
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

export interface SeoKeyword {
  id: string;
  phrase: string;
  search_volume: number | null;
  difficulty: number | null;
  intent: string | null;
  is_branded: boolean;
  est_value_monthly: string | null;
  position: number | null;
  checked_on: string | null;
}

export interface SeoCompetitor {
  id: string;
  name: string;
  domain: string;
  discovered: boolean;
  avg_position: string | null;
  tracked_keywords: number;
}

export interface SeoCrawlHistoryEntry {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  pages_crawled: number;
  trigger: string;
  error: string | null;
  health: number | null;
}

export type ContentPageStatus = 'draft' | 'approved' | 'published';

export interface ContentPage {
  id: string;
  kind: string;
  url: string | null;
  slug: string | null;
  title: string | null;
  meta_description: string | null;
  h1: string | null;
  body?: string | null;
  status: ContentPageStatus;
  generated_by: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---- Reviews ---------------------------------------------------------------
export type ReviewSource = 'manual' | 'google' | 'facebook' | 'yelp';
export type ReviewResponseStatus = 'none' | 'drafted' | 'published';

export interface Review {
  id: string;
  source: ReviewSource;
  author_name: string;
  rating: number;
  body: string | null;
  reviewed_at: string;
  response_body: string | null;
  response_status: ReviewResponseStatus;
  responded_at: string | null;
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
  deal_title: string | null;
  deal_value: string | null;
}

export interface ScheduledJob {
  id: string;
  title: string;
  status: string;
  scheduled_start: string | null;
  display_name: string;
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

// ---- Service area / market_targets --------------------------------------
export interface ServiceLocation {
  id: string;
  name: string;
  slug: string;
  region: string | null;
  country?: string;
  radius_miles: string | null;
  is_primary: boolean;
  priority: number;
}

export type ServiceAreaMode = 'cities' | 'radius';

export interface ServiceArea {
  service_area_mode: ServiceAreaMode;
  service_radius_miles: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string;
  locations: ServiceLocation[];
}

export interface CoverageGap {
  catalog_item_id: string;
  service_name: string;
  location_id: string;
  location_name: string;
  market_target_id: string | null;
  status: string | null;
  uncovered_in_location: number;
}

// ---- Google Search Console ------------------------------------------------
export interface GscStatus {
  connected: boolean;
  propertyUrl: string | null;
  status: string;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface GscQueryRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: string | null;
  position: string | null;
}

export interface GscQueriesResponse {
  connected: boolean;
  rows: GscQueryRow[];
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

// ---- Grow ----------------------------------------------------------------

export type GrowCampaignStatus = 'draft' | 'running' | 'paused' | 'stopped' | 'done' | 'archived';

export interface GrowCampaign {
  id: string;
  name: string;
  status: GrowCampaignStatus;
  timezone: string;
  window_start: string;
  window_end: string;
  weekdays_only: boolean;
  daily_target: number;
  start_date: string | null;
  end_date: string | null;
  // Computed read-time, not stored — true once end_date has passed in the
  // campaign's own timezone. Nothing auto-transitions `status` (no worker
  // exists to do that); the UI uses this to show "Ended" instead of
  // leaving a running/paused campaign looking like it's just sitting idle.
  past_end_date: boolean;
  pause_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface GrowSequenceStep {
  id: string;
  campaign_id: string;
  step_no: number;
  delay_days: number;
  applies_to_rank: number | null;
  subject_tmpl: string;
  body_tmpl: string;
  created_at: string;
  updated_at: string;
}

export interface GrowGeneratedStep {
  step_no: number;
  delay_days: number;
  applies_to_rank: number | null;
  subject_tmpl: string;
  body_tmpl: string;
}

export interface GrowSequenceGenerateResponse {
  steps: GrowGeneratedStep[];
}

export type GrowAssistInstruction = 'rewrite' | 'shorten' | 'tone' | 'direct';

export interface GrowProductUrl {
  label: string;
  url: string;
}

export interface GrowSenderProfile {
  sender_name: string | null;
  website_url: string | null;
  phone: string | null;
  contact_email: string | null;
  mailing_address: string | null;
  product_urls: GrowProductUrl[];
}

// ---- Grow sending setup -----------------------------------------------------

export type GrowSendingDomainProvider = 'spacemail' | 'google' | 'microsoft' | 'other';

export interface GrowExpectedDnsRecord {
  type: 'SPF' | 'DKIM' | 'DMARC';
  kind: 'TXT' | 'CNAME';
  name: string;
  value: string | null;
  instructions: string;
}

export interface GrowSendingDomain {
  id: string;
  domain: string;
  provider: GrowSendingDomainProvider;
  spf_ok: boolean;
  dkim_ok: boolean;
  dmarc_ok: boolean;
  verified_at: string | null;
  expected_records: GrowExpectedDnsRecord[];
}

export interface GrowDnsCheckResult {
  type: 'SPF' | 'DKIM' | 'DMARC';
  ok: boolean;
  expected: string | null;
  found: string[];
  note: string;
}

export interface GrowVerifyDomainResponse extends GrowSendingDomain {
  checks: GrowDnsCheckResult[];
  subdomain_warning: string | null;
}

export type GrowMailboxStatus = 'warming' | 'active' | 'paused' | 'disabled';

export interface GrowMailbox {
  id: string;
  domain_id: string;
  domain: string;
  address: string;
  from_name: string;
  reply_to: string | null;
  smtp_host: string;
  smtp_port: number;
  imap_host: string | null;
  imap_port: number | null;
  username: string;
  warmup_started_on: string | null;
  steady_cap: number;
  status: GrowMailboxStatus;
  daily_cap: number;
  steady_cap_date: string | null;
  last_health_at: string | null;
  created_at: string;
  updated_at: string;
  // True if any grow_messages row references this mailbox — the UI uses
  // this to explain up front why the address field is locked, rather than
  // only surfacing it after a failed save.
  has_message_history: boolean;
}

export interface GrowSmtpTestResult {
  ok: boolean;
  messageId: string | null;
  response: string | null;
  error: string | null;
}

export interface GrowImapTestResult {
  ok: boolean;
  messageCount: number | null;
  error: string | null;
}

export interface GrowTestSendResponse {
  smtp: GrowSmtpTestResult;
  imap: GrowImapTestResult;
}

export interface GrowSendingReadiness {
  hasVerifiedDomain: boolean;
  hasActiveMailbox: boolean;
  ready: boolean;
}

// Campaign "Send test" (with merge) — distinct from GrowTestSendResponse
// above, which is the sending-setup mailbox connectivity check. This one
// renders a real sequence step for a real or hypothetical contact and
// sends it through a real mailbox, but writes nothing and touches no
// enrollment.
export interface GrowCampaignTestSendRenderResponse {
  subject: string;
  body: string;
  refused: boolean;
  refusal_reason: string | null;
}

export interface GrowCampaignTestSendResponse extends GrowCampaignTestSendRenderResponse {
  smtp: GrowSmtpTestResult | null;
}

export type GrowEnrollmentState =
  | 'active' | 'replied' | 'bounced' | 'unsubscribed' | 'completed' | 'held' | 'failed';

export type GrowSuppressionReason =
  | 'unsubscribed' | 'hard_bounce' | 'complaint' | 'manual' | 'chain_overflow';

export interface GrowContactListItem {
  id: string;
  email: string;
  first_name: string | null;
  contact_name: string | null;
  role: string | null;
  contact_rank: number;
  entity_name: string | null;
  region: string | null;
  city: string | null;
  state: string | null;
  recipient_domain: string;
  tier: string | null;
  is_chain: boolean;
  domain_rank: number | null;
  source_profile: string | null;
  created_at: string;
  // Whichever enrollment is "current" for this row: the contact's most
  // recently touched one across any campaign by default, or specifically
  // its enrollment in the campaign the list is filtered to, once a
  // campaign filter is set — see api/src/routes/grow.ts's CONTACT_JOIN_SQL.
  enrollment_id: string | null;
  latest_enrollment_state: GrowEnrollmentState | null;
  enrollment_campaign_id: string | null;
  suppression_id: string | null;
  suppression_reason: GrowSuppressionReason | null;
  suppression_created_at: string | null;
}

export interface GrowContactIdsResponse {
  ids: string[];
  truncated: boolean;
}

export interface GrowContactCreateResponse {
  id: string;
  email: string;
  first_name: string | null;
  contact_name: string | null;
  role: string | null;
  contact_rank: number;
  entity_name: string | null;
  region: string | null;
  city: string | null;
  state: string | null;
  recipient_domain: string;
  tier: string | null;
  is_chain: boolean;
  domain_rank: number | null;
  source_profile: string | null;
  created_at: string;
}

export interface GrowBulkDeleteContactsResponse {
  deleted: number;
  blocked: Array<{ id: string; email: string }>;
}

export interface GrowSuppressResponse {
  alreadySuppressed: boolean;
  suppression: { id: string; reason: GrowSuppressionReason; created_at: string };
}

export interface GrowBulkSuppressResponse {
  suppressed: number;
  alreadySuppressed: number;
}

export interface GrowEnrollmentDeleteResponse {
  removed: boolean;
  ungated: number;
}

export interface GrowBulkEnrollmentDeleteResponse {
  removed: number;
  ungated: number;
}

export interface GrowClearAllContactsResponse {
  deleted: number;
}

export interface GrowContactPreview {
  contact_id: string;
  campaign_id: string;
  campaign_name: string;
  enrollment_id: string;
  step_no: number;
  to: string;
  subject: string;
  body: string;
  unsubscribe_url: string;
  refused: boolean;
  refusal_reason: string | null;
}

export type GrowMessageStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'bounced' | 'cancelled';

export interface GrowMessage {
  id: string;
  campaign_id: string;
  contact_id: string;
  mailbox_id: string;
  step_no: number;
  recipient_domain: string;
  subject: string;
  status: GrowMessageStatus;
  scheduled_at: string;
  sent_at: string | null;
  attempts: number;
  error: string | null;
}

export interface GrowMailboxCapacity {
  id: string;
  address: string;
  status: string;
  cap: number;
  sent_today: number;
  remaining: number;
}

export interface GrowDomainCapacity {
  domain: string;
  daily_cap: number;
  sent_today: number;
  remaining: number;
}

export interface GrowStats {
  sent_today: number;
  queue_depth: number;
  contacts_enrolled: number;
  bounce_rate: number;
  bounce_threshold: number;
  complaint_rate: number;
  complaint_threshold: number;
  mailbox_capacity: GrowMailboxCapacity[];
  domain_capacity: GrowDomainCapacity[];
}

// ---- Grow schedule & pacing -------------------------------------------------

export interface GrowDomainPolicy {
  id: string | null;
  domain: string;
  daily_cap: number;
  enrolled_contacts: number;
  sent_today: number;
  remaining: number;
  is_default: boolean;
  is_consumer: boolean;
  is_saved: boolean;
}

export type GrowScheduleBinding = 'mailbox_capacity' | 'domain_caps' | 'daily_target';

export interface GrowScheduleDay {
  date: string;
  mailbox_capacity: number;
  domain_capacity: number;
  daily_target: number;
  sent: number;
  binding: GrowScheduleBinding;
}

export interface GrowScheduleProjection {
  completion_date: string | null;
  horizon_exceeded: boolean;
  // True when the campaign's own end_date was reached with sends still
  // remaining — a real deadline missed, distinct from horizon_exceeded
  // (this projection's own 180-day simulation cap).
  deadline_exceeded: boolean;
  remaining_sends: number;
  blocked_reason: 'no_mailbox_capacity' | 'no_domain_capacity' | null;
  days: GrowScheduleDay[];
  start_date: string | null;
  end_date: string | null;
  // null when end_date isn't set — there's no deadline to be on/off track
  // against. false means completion_date is null or falls after end_date.
  on_track: boolean | null;
  // Smallest daily_target that would finish by end_date under the same
  // mailbox ramp and domain caps, only computed when on_track is false.
  // Null either when there's no deadline, or when even an unlimited
  // daily_target can't finish in time — meaning capacity itself, not the
  // target, is the real constraint.
  needed_daily_target: number | null;
}

export interface GrowCircuitBreaker {
  sent: number;
  bounced: number;
  complaints: number;
  bounce_rate: number;
  bounce_threshold: number;
  complaint_rate: number;
  complaint_threshold: number;
  sample_size_met: boolean;
  min_sample: number;
}

export interface GrowMailboxRampPoint {
  date: string;
  cap: number;
}

export interface GrowMailboxRamp {
  id: string;
  address: string;
  status: GrowMailboxStatus;
  steady_cap: number;
  warmup_started_on: string | null;
  steady_cap_date: string | null;
  current_cap: number;
  points: GrowMailboxRampPoint[];
}

export interface GrowScheduleProjectionResponse {
  circuit_breaker: GrowCircuitBreaker;
  projection: GrowScheduleProjection;
  mailbox_ramps: GrowMailboxRamp[];
}

// ---- Grow contacts import --------------------------------------------------

export interface GrowImportSlotMapping {
  label: string;
  rank: number | null;
  fields: Record<string, string | null>;
}

export interface GrowImportMapping {
  format: 'long' | 'wide';
  shared: Record<string, string | null>;
  slots: GrowImportSlotMapping[];
}

export interface GrowImportInspectResponse {
  headers: string[];
  rowCount: number;
  sampleRows: Record<string, string>[];
  suggestedMapping: GrowImportMapping;
  hasSavedProfile: boolean;
  usedSavedProfile: boolean;
  note: string | null;
}

export interface GrowImportRejectionExample {
  line: number;
  email: string;
  detail: string;
}

export interface GrowImportRejectionGroup {
  code: string;
  count: number;
  examples: GrowImportRejectionExample[];
}

export interface GrowImportSummary {
  totalRows: number;
  acceptedCount: number;
  rejectedCount: number;
  byTier: Array<{ tier: string; count: number }>;
  uniqueDomains: number;
  rejectionsByCode: GrowImportRejectionGroup[];
}

export interface GrowImportPreviewResponse extends GrowImportSummary {
  note: string | null;
}

export interface GrowImportCommitResponse extends GrowImportSummary {
  note?: string | null;
  inserted: number;
  alreadyExisted: number;
}

// ---- Admin ---------------------------------------------------------------
export interface AdminSummary {
  userCount: number;
  orgCount: number;
  waitlistNewCount: number;
}

export interface AdminUser {
  id: string;
  email: string;
  full_name: string;
  is_platform_staff: boolean;
  mfa_enabled: boolean;
  last_login_at: string | null;
  created_at: string;
}

export type OrgModules = Record<string, boolean>;

export interface AdminOrganization {
  id: string;
  name: string;
  slug: string;
  status: string;
  vertical: string | null;
  modules: OrgModules;
  created_at: string;
  owner_email: string | null;
  member_count: number;
  site_count: number;
}

export interface AdminOrgMember {
  id: string;
  email: string;
  full_name: string;
  role: string;
  member_since: string;
}

export interface AdminOrgSite {
  id: string;
  in_health_score: boolean;
  is_primary: boolean;
}

export interface AdminOrganizationDetail {
  id: string;
  name: string;
  slug: string;
  status: string;
  vertical: string | null;
  website_url: string | null;
  modules: OrgModules;
  created_at: string;
  members: AdminOrgMember[];
  sites: AdminOrgSite[];
}

export type WaitlistStatus = 'new' | 'contacted' | 'converted';

export interface WaitlistEntry {
  id: string;
  email: string;
  business_name: string | null;
  website_url: string | null;
  phone: string | null;
  interest: string | null;
  source_page: string | null;
  status: WaitlistStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

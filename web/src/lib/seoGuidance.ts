// Plain-English "what this means and how to fix it" for every issue code
// workers/seo/scoring.py's RULES table can produce — a fixed, finite
// vocabulary (verified against that file directly, not guessed), so this
// is a real lookup, not best-effort pattern matching on freeform text.
//
// `who` mostly follows that file's own `auto_fixable` flag: the codes it
// marks auto_fixable are short, well-defined text (a title, a meta
// description, alt text) that the real AI Page Builder already drafts —
// marked 'ai' here for that reason, not a guess. The rest are judgment
// calls based on what the fix actually requires: a quick manual edit
// ('diy'), or a template/server/hosting change a developer would do
// ('pro'). thin_content is 'ai' despite not being auto_fixable because
// drafting a fuller page body is exactly what the AI Page Builder is for.
export type WhoCanDo = 'diy' | 'ai' | 'pro';

export interface IssueGuidance {
  customerImpact: string;
  whyItMatters: string;
  steps: string[];
  timeEstimate: string;
  who: WhoCanDo;
}

export const WHO_LABEL: Record<WhoCanDo, string> = {
  diy: 'You can do this yourself',
  ai: 'AI can draft it — you approve',
  pro: 'Needs a developer or your web person',
};

export const ISSUE_GUIDANCE: Record<string, IssueGuidance> = {
  broken_internal_link: {
    customerImpact: 'Someone clicks a link on your own site and lands on an error page instead of what they were looking for.',
    whyItMatters: "It looks unpolished, and search engines treat dead links as a sign a site isn't well maintained.",
    steps: ['Open the page the link is on.', 'Update the link to point to the right page, or remove it if that page is gone for good.'],
    timeEstimate: 'A few minutes per link',
    who: 'diy',
  },
  page_error: {
    customerImpact: "The page doesn't load at all for visitors.",
    whyItMatters: "A page that won't load can't bring in a single customer, and search engines will eventually stop showing it.",
    steps: ['Share this with your hosting provider or web developer — it usually means the server, not the content, is the problem.', 'Confirm the page loads again after the fix.'],
    timeEstimate: 'Can be quick, or a day if it needs a hosting fix',
    who: 'pro',
  },
  server_error: {
    customerImpact: 'Visitors see a generic error page instead of your content.',
    whyItMatters: "No visitor can act on a page that's throwing an error, and it can shake trust in the rest of the site.",
    steps: ['Share this with your hosting provider or web developer — a server error is not something fixable from a page editor.', 'Re-check the page once they confirm a fix.'],
    timeEstimate: 'Usually same-day once reported',
    who: 'pro',
  },
  noindex_page: {
    customerImpact: "This page is invisible in Google — someone searching for exactly what's on it won't find it.",
    whyItMatters: "If this wasn't on purpose, it's a page's worth of visibility given up for free.",
    steps: ["Open the page's SEO settings (most website builders have a “hide from search engines” toggle).", 'Turn it off, unless this page was deliberately hidden (a thank-you page, for example).'],
    timeEstimate: 'A couple of minutes',
    who: 'diy',
  },
  missing_title: {
    customerImpact: 'This is the clickable blue headline people see for your page in Google results — right now it’s blank or generic.',
    whyItMatters: "It's the first thing a potential customer reads before ever reaching your site. A missing one hurts both ranking and click-through.",
    steps: ['Venturelyx can draft a title for this page in AI Page Builder.', 'Review it and publish it to the page.'],
    timeEstimate: 'A few minutes once drafted',
    who: 'ai',
  },
  missing_h1: {
    customerImpact: 'The page has no clear main heading telling a visitor what it’s about.',
    whyItMatters: 'Both visitors and search engines use this heading to quickly understand the page — without one it reads as unfinished.',
    steps: ['Add one clear heading near the top of the page stating what it’s about.'],
    timeEstimate: 'A few minutes',
    who: 'diy',
  },
  duplicate_title: {
    customerImpact: 'Two of your pages show the exact same headline in search results, so it’s unclear which one is relevant.',
    whyItMatters: 'Search engines get confused about which page to rank too, which can hurt both.',
    steps: ['Open each of the two pages.', 'Give each one its own specific title describing what’s unique about it.'],
    timeEstimate: 'A few minutes per page',
    who: 'diy',
  },
  missing_meta_desc: {
    customerImpact: 'This is the couple of sentences under your page’s headline in Google results — right now it’s blank, so Google shows a random snippet instead.',
    whyItMatters: 'A good one is a mini advertisement for your page; a missing one is a missed chance to earn the click.',
    steps: ['Venturelyx can draft one for this page in AI Page Builder.', 'Review it and publish it.'],
    timeEstimate: 'A few minutes once drafted',
    who: 'ai',
  },
  duplicate_meta_desc: {
    customerImpact: 'Two pages show the identical summary text in search results.',
    whyItMatters: 'It makes the two pages look interchangeable to searchers and search engines, when they’re probably not.',
    steps: ['Venturelyx can draft a distinct description for each page.', 'Review and publish both.'],
    timeEstimate: 'A few minutes once drafted',
    who: 'ai',
  },
  title_too_long: {
    customerImpact: 'Your page’s headline gets cut off with “…” in search results.',
    whyItMatters: 'Whatever message was in the cut-off part never reaches the searcher.',
    steps: ['Venturelyx can draft a shorter version that keeps the key message.', 'Review and publish it.'],
    timeEstimate: 'A few minutes once drafted',
    who: 'ai',
  },
  title_too_short: {
    customerImpact: 'The headline doesn’t say enough to convince someone searching to click.',
    whyItMatters: 'A short, vague title competes poorly against competitors whose titles clearly state what they offer.',
    steps: ['Venturelyx can draft a more complete title.', 'Review and publish it.'],
    timeEstimate: 'A few minutes once drafted',
    who: 'ai',
  },
  meta_desc_too_long: {
    customerImpact: 'Your page’s summary text gets cut off in search results.',
    whyItMatters: 'Same as a cut-off title — the end of your pitch to a potential customer never gets seen.',
    steps: ['Venturelyx can draft a tighter version.', 'Review and publish it.'],
    timeEstimate: 'A few minutes once drafted',
    who: 'ai',
  },
  multiple_h1: {
    customerImpact: 'The page has more than one “main heading,” which can look visually inconsistent.',
    whyItMatters: 'It also confuses search engines about what the page is actually about.',
    steps: ['Keep one clear main heading.', 'Change the others to a smaller subheading style.'],
    timeEstimate: 'A few minutes',
    who: 'diy',
  },
  images_missing_alt: {
    customerImpact: 'Someone using a screen reader (common for visually impaired visitors) can’t tell what these images show.',
    whyItMatters: 'It’s both an accessibility gap and a missed ranking signal — Google uses this text to understand images.',
    steps: ['Venturelyx can draft short descriptions for these images.', 'Review and add them to each image.'],
    timeEstimate: 'A few minutes per image once drafted',
    who: 'ai',
  },
  thin_content: {
    customerImpact: 'This page doesn’t say much — a visitor may not find enough information to make a decision.',
    whyItMatters: 'Thin pages tend to rank poorly and give a potential customer little reason to trust or choose you.',
    steps: ['Venturelyx’s AI Page Builder can draft a fuller first version of the page for you to edit.', 'Review it, add any specifics only you’d know, and publish.'],
    timeEstimate: '20–30 minutes to review and publish once drafted',
    who: 'ai',
  },
  duplicate_content: {
    customerImpact: 'Two pages on your site say basically the same thing.',
    whyItMatters: 'Search engines may only show one of them (and might pick the wrong one), and it can look like filler to a visitor comparing pages.',
    steps: ['Decide which page should stay as the “real” one.', 'Ask your web person to rewrite or remove the other, especially if the duplication comes from a page template.'],
    timeEstimate: 'Quick if it’s one page; needs developer time if it’s templated',
    who: 'pro',
  },
  redirect_chain: {
    customerImpact: 'A link bounces through several pages before landing where it’s supposed to — slower, and occasionally breaks.',
    whyItMatters: 'Each hop adds load time and makes search engines less confident which page is the real destination.',
    steps: ['A web developer updates the redirect to point straight to the final page instead of chaining through others.'],
    timeEstimate: 'Usually quick for a developer with access to the site’s redirect rules',
    who: 'pro',
  },
  slow_page: {
    customerImpact: 'The page takes noticeably long to load — visitors on mobile or a slow connection may give up and leave.',
    whyItMatters: 'Slow pages lose visitors before they see your content, and search engines factor speed into rankings.',
    steps: ['A web developer checks image sizes, plugins, and hosting — the most common causes.'],
    timeEstimate: 'From a quick image-compression fix to a bigger hosting conversation',
    who: 'pro',
  },
  missing_canonical: {
    customerImpact: 'Not something a visitor sees directly.',
    whyItMatters: 'It tells search engines which version of a page’s URL is the “real” one to rank — without it, near-identical URLs can quietly split your ranking strength.',
    steps: ['Venturelyx can set this the next time this page is rebuilt through AI Page Builder, or ask your web person to add a canonical tag directly.'],
    timeEstimate: 'A few minutes for a developer',
    who: 'ai',
  },
  broken_external_link: {
    customerImpact: 'A link to another website on your page no longer works.',
    whyItMatters: 'Minor on its own, but enough of these make a page look outdated and unmaintained.',
    steps: ['Update the link, or remove it if the other site is gone.'],
    timeEstimate: 'A couple of minutes',
    who: 'diy',
  },
  no_schema: {
    customerImpact: 'Not something a visitor sees directly.',
    whyItMatters: 'This is extra structured information that helps Google show richer results for your page (like star ratings or hours directly in search) — without it, you’re invisible to those richer formats.',
    steps: ['Venturelyx can draft the structured data for this page type.', 'A developer adds it to the page template.'],
    timeEstimate: 'A few minutes to draft, then a quick add by a developer',
    who: 'ai',
  },
};

export const FALLBACK_GUIDANCE: IssueGuidance = {
  customerImpact: 'This affects how search engines and visitors experience this page.',
  whyItMatters: 'Fixing it is a straightforward way to keep the site in good technical health.',
  steps: ['Review the example page and detail above.', 'Ask your web person if you’re not sure what changed.'],
  timeEstimate: 'Varies',
  who: 'pro',
};

# Venturelyx — "Daylight Ledger" design system

The primary user reads this on a phone, outdoors, between jobs. Light-first,
high contrast, no decorative chrome.

## Tokens

```css
--deepwater: #0E323C;   --deepwater-2: #14434F;
--daylight:  #FBF8F3;   --card: #FFFFFF;  --card-sunk: #F6F2EA;
--ink: #16262A;         --ink-2: #41565A; --ink-3: #7A8C8F;
--pool:   #0F7A70;      --pool-soft:   #E2F0EE;   /* primary action */
--sun:    #DE9827;      --sun-soft:    #FBF0DC;   /* attention */
--growth: #2C7A4B;      --growth-soft: #E5F1E9;   /* positive */
--alert:  #BE4437;      --alert-soft:  #F8E6E4;   /* negative */
--line:   #E8E2D6;      --line-2:      #F1ECE2;
--shadow: 0 1px 2px rgb(14 50 60/.06), 0 1px 3px rgb(14 50 60/.04);
```

Fonts: **Bricolage Grotesque** (display, 700–800), **Archivo** (UI),
**IBM Plex Mono** (every number, `font-variant-numeric: tabular-nums`).

## Rules

- **Money is always monospace and always carries its source.** Not "$24,380"
  but "$24,380 — Found on Google $10,970, Repeat customers $8,530…"
- **One shadow level.** Hierarchy comes from spacing and type weight.
- Cards: 14px radius, 1px `--line-2` border, 16px padding.
- Buttons: 42px min height, 11px radius. Primary `--pool`, attention `--sun`.
- Copy in the owner's words: "Money owed to you", not "Accounts receivable".

## Signature component — Next Move

One dark `--deepwater` gradient card at the top of Command Center. Eyebrow
"YOUR NEXT BEST MOVE" with an amber pulse dot, then one specific action with
its reasoning and expected value in monospace. Two buttons: act, or dismiss.
Everything else on the page is a supporting detail.

## Layout

Mobile-first. Phone: 5 bottom tabs (Home, Customers, Search, Grow, More).
Desktop ≥1080px: dark `--deepwater` sidebar, modules numbered 01–06 to show
the business lifecycle — Build, Source, Operate, ScaleSEO, Grow, AI Team.

## Org switcher

Top-left, always visible. Lists every business the user belongs to **with its
health score**, so the portfolio view is one tap away rather than a separate
screen. Single-business clients never notice; multi-business owners get what
they need. After sign-in, land in the last-used business.

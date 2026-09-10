'use client';

// Shared between /onboarding and Settings — same split as BusinessProfileForm.
// Presentational only: the parent owns loading initial values and saving.
import { Plus, Trash } from '@phosphor-icons/react';
import type { ServiceAreaMode } from '@/lib/types';

export interface CityEntry {
  name: string;
  region: string;
  isPrimary: boolean;
}

export interface ServiceAreaValues {
  mode: ServiceAreaMode;
  cities: CityEntry[];
  address_line1: string;
  address_line2: string;
  city: string;
  region: string;
  postal_code: string;
  radiusMiles: string;
}

export const BLANK_CITY: CityEntry = { name: '', region: '', isPrimary: false };

export const BLANK_SERVICE_AREA: ServiceAreaValues = {
  mode: 'cities',
  cities: [{ ...BLANK_CITY }],
  address_line1: '',
  address_line2: '',
  city: '',
  region: '',
  postal_code: '',
  radiusMiles: '',
};

/** Rows with a real name, ready for the PUT /service-area payload. */
export function realCities(cities: CityEntry[]): CityEntry[] {
  return cities.filter((c) => c.name.trim() !== '');
}

// US states/territories, full name and postal abbreviation — this field
// feeds market_targets x locations coverage matching (workers/seo/coverage.py
// matches crawled page text against the city name), so "Florida" here
// produces a location no real page will ever mention. Heuristic only: it
// catches the common mistake without pretending to validate real places.
const STATE_NAMES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
  'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan',
  'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina',
  'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island',
  'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont',
  'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming',
  'district of columbia', 'puerto rico',
]);
const STATE_ABBREVIATIONS = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in',
  'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv',
  'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn',
  'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy', 'dc', 'pr',
]);

/** Non-blocking hint text when a "city" entry looks like a state/county instead. */
export function cityWarning(name: string): string | null {
  const v = name.trim().toLowerCase();
  if (!v) return null;
  if (STATE_NAMES.has(v) || STATE_ABBREVIATIONS.has(v)) {
    return 'That looks like a state, not a city — try the city it does business in instead.';
  }
  if (/\bcounty\b/.test(v)) {
    return 'That looks like a county, not a city — try a specific city within it instead.';
  }
  return null;
}

const inputCls =
  'min-h-[42px] w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
// Row inputs share space via flex-grow instead of `w-full` — `w-full` and a
// flex-basis utility fighting over the same box is what previously crushed
// the City input to a sliver while State (still carrying inputCls's w-full)
// ballooned to fill the row. min-w-0 lets both actually shrink on a narrow
// screen instead of overflowing the card at their default content width.
const rowInputCls =
  'min-h-[42px] min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const labelCls = 'flex flex-col gap-1 text-sm text-muted-foreground';

export function ServiceAreaForm({
  values,
  onChange,
}: {
  values: ServiceAreaValues;
  onChange: (values: ServiceAreaValues) => void;
}) {
  function updateCity(i: number, patch: Partial<CityEntry>) {
    onChange({ ...values, cities: values.cities.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) });
  }
  // Only one HQ / main service city at a time — checking one clears the rest
  // rather than requiring the person to uncheck it themselves.
  function setPrimary(i: number, isPrimary: boolean) {
    onChange({
      ...values,
      cities: values.cities.map((c, idx) => ({ ...c, isPrimary: idx === i ? isPrimary : isPrimary ? false : c.isPrimary })),
    });
  }
  function addCity() {
    onChange({ ...values, cities: [...values.cities, { ...BLANK_CITY }] });
  }
  function removeCity(i: number) {
    onChange({ ...values, cities: values.cities.filter((_, idx) => idx !== i) });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex w-fit gap-1 rounded-full border border-border bg-surface p-1 shadow-sm">
        {(['cities', 'radius'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onChange({ ...values, mode: m })}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              values.mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {m === 'cities' ? 'List of cities' : 'Radius from address'}
          </button>
        ))}
      </div>

      {values.mode === 'cities' ? (
        <div className="flex min-w-0 flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Enter specific cities, not states or counties — coverage gaps are matched against real
            crawled pages, so a row like "Florida" will never match anything.
          </p>

          {/* Column labels once, not per row — same flex ratios as the row
              below so they roughly line up without repeating "City"/"State"
              text on every line. */}
          <div className="hidden gap-2 px-1 text-xs font-medium text-muted-foreground sm:flex">
            <span className="min-w-0 flex-[2]">City</span>
            <span className="min-w-0 flex-1">State</span>
            <span className="w-[132px] shrink-0" aria-hidden />
          </div>

          <div className="flex flex-col gap-2">
            {values.cities.map((c, i) => {
              const warning = cityWarning(c.name);
              return (
                <div key={i} className="min-w-0 rounded-lg border border-border/60 p-2 sm:border-0 sm:p-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <div className="flex min-w-[220px] flex-1 gap-2">
                      <input
                        placeholder="City"
                        aria-label="City"
                        value={c.name}
                        onChange={(e) => updateCity(i, { name: e.target.value })}
                        className={`${rowInputCls} flex-[2]`}
                      />
                      <input
                        placeholder="State"
                        aria-label="State"
                        value={c.region}
                        onChange={(e) => updateCity(i, { region: e.target.value })}
                        className={`${rowInputCls} flex-1`}
                      />
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <input type="checkbox" checked={c.isPrimary} onChange={(e) => setPrimary(i, e.target.checked)} />
                        Primary
                      </label>
                      <button
                        type="button"
                        onClick={() => removeCity(i)}
                        aria-label="Remove city"
                        className="shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-destructive"
                      >
                        <Trash size={14} />
                      </button>
                    </div>
                  </div>
                  {warning && <p className="mt-1.5 text-xs text-destructive">{warning}</p>}
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={addCity}
            className="flex w-fit items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            <Plus size={14} weight="bold" /> Add city
          </button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={`${labelCls} sm:col-span-2`}>
            Business address
            <input
              placeholder="Street address"
              value={values.address_line1}
              onChange={(e) => onChange({ ...values, address_line1: e.target.value })}
              className={inputCls}
            />
          </label>
          <label className={labelCls}>
            City
            <input
              value={values.city}
              onChange={(e) => onChange({ ...values, city: e.target.value })}
              className={inputCls}
            />
          </label>
          <label className={labelCls}>
            State / region
            <input
              value={values.region}
              onChange={(e) => onChange({ ...values, region: e.target.value })}
              className={inputCls}
            />
          </label>
          <label className={labelCls}>
            Postal code
            <input
              value={values.postal_code}
              onChange={(e) => onChange({ ...values, postal_code: e.target.value })}
              className={inputCls}
            />
          </label>
          <label className={labelCls}>
            Radius (miles)
            <input
              type="number"
              min="1"
              max="500"
              value={values.radiusMiles}
              onChange={(e) => onChange({ ...values, radiusMiles: e.target.value })}
              className={inputCls}
            />
          </label>
        </div>
      )}
    </div>
  );
}

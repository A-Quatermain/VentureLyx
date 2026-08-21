'use client';

// Shared between /onboarding and Settings' Business card — an owner who
// skips intake fills in the same fields here instead, later.
export interface BusinessProfileValues {
  name: string;
  website_url: string;
  vertical: string;
  service_area: string;
}

const inputCls =
  'min-h-[42px] w-full rounded-none border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary';
const labelCls = 'flex flex-col gap-1 text-sm text-muted-foreground';

export function BusinessProfileForm({
  values,
  onChange,
  nameRequired = true,
}: {
  values: BusinessProfileValues;
  onChange: (values: BusinessProfileValues) => void;
  nameRequired?: boolean;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className={`${labelCls} sm:col-span-2`}>
        Business name
        {nameRequired && <span className="text-primary">*</span>}
        <input
          required={nameRequired}
          value={values.name}
          onChange={(e) => onChange({ ...values, name: e.target.value })}
          className={inputCls}
        />
      </label>
      <label className={labelCls}>
        Website
        <input
          type="url"
          placeholder="https://example.com"
          value={values.website_url}
          onChange={(e) => onChange({ ...values, website_url: e.target.value })}
          className={inputCls}
        />
      </label>
      <label className={labelCls}>
        Industry
        <input
          value={values.vertical}
          onChange={(e) => onChange({ ...values, vertical: e.target.value })}
          className={inputCls}
        />
      </label>
      <label className={`${labelCls} sm:col-span-2`}>
        Service area
        <input
          placeholder="e.g. Miami-Dade County"
          value={values.service_area}
          onChange={(e) => onChange({ ...values, service_area: e.target.value })}
          className={inputCls}
        />
      </label>
    </div>
  );
}

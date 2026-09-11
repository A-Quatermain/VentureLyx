'use client';

// Presentational only, same split as BusinessProfileForm/ServiceAreaForm —
// the parent (Settings' GrowSenderProfileCard) owns loading initial values
// and saving via PUT /grow/sender-profile.
import { Plus, Trash } from '@phosphor-icons/react';
import type { GrowProductUrl } from '@/lib/types';
import { Button } from '@/components/ui/Button';

export interface GrowSenderProfileValues {
  sender_name: string;
  website_url: string;
  phone: string;
  contact_email: string;
  mailing_address: string;
  product_urls: GrowProductUrl[];
}

export const BLANK_PRODUCT_URL: GrowProductUrl = { label: '', url: '' };

export const BLANK_SENDER_PROFILE: GrowSenderProfileValues = {
  sender_name: '',
  website_url: '',
  phone: '',
  contact_email: '',
  mailing_address: '',
  product_urls: [{ ...BLANK_PRODUCT_URL }],
};

/** Rows with both a label and a URL, ready for the PUT payload. */
export function realProductUrls(rows: GrowProductUrl[]): GrowProductUrl[] {
  return rows.filter((p) => p.label.trim() !== '' && p.url.trim() !== '');
}

const inputCls =
  'min-h-[42px] w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const labelCls = 'flex flex-col gap-1 text-sm text-muted-foreground';

export function GrowSenderProfileForm({
  values,
  onChange,
}: {
  values: GrowSenderProfileValues;
  onChange: (values: GrowSenderProfileValues) => void;
}) {
  function updateProduct(i: number, patch: Partial<GrowProductUrl>) {
    onChange({
      ...values,
      product_urls: values.product_urls.map((p, idx) => (idx === i ? { ...p, ...patch } : p)),
    });
  }

  function addProduct() {
    onChange({ ...values, product_urls: [...values.product_urls, { ...BLANK_PRODUCT_URL }] });
  }

  function removeProduct(i: number) {
    onChange({ ...values, product_urls: values.product_urls.filter((_, idx) => idx !== i) });
  }

  return (
    <div className="flex flex-col gap-4">
      <label className={labelCls}>
        Sender / brand name
        <input
          placeholder="CampusPath"
          value={values.sender_name}
          onChange={(e) => onChange({ ...values, sender_name: e.target.value })}
          className={inputCls}
        />
        <span className="text-xs text-muted-foreground/70">
          Resolves {'{{sender_name}}'} — the product name people should recognize, not necessarily this org&apos;s
          full registered name. Each mailbox&apos;s own From name (Sending setup) is what actually shows in a
          recipient&apos;s inbox; set that to match.
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className={labelCls}>
          Website
          <input
            type="url"
            placeholder="https://example.com"
            value={values.website_url}
            onChange={(e) => onChange({ ...values, website_url: e.target.value })}
            className={inputCls}
          />
          <span className="text-xs text-muted-foreground/70">Resolves {'{{sender_website}}'} in Grow sequences.</span>
        </label>
        <label className={labelCls}>
          Phone
          <input
            type="tel"
            placeholder="(555) 123-4567"
            value={values.phone}
            onChange={(e) => onChange({ ...values, phone: e.target.value })}
            className={inputCls}
          />
          <span className="text-xs text-muted-foreground/70">Resolves {'{{sender_phone}}'}.</span>
        </label>
      </div>

      <label className={labelCls}>
        Contact email
        <input
          type="email"
          placeholder="hello@example.com"
          value={values.contact_email}
          onChange={(e) => onChange({ ...values, contact_email: e.target.value })}
          className={inputCls}
        />
        <span className="text-xs text-muted-foreground/70">
          Resolves {'{{sender_email}}'} — a reply-to style address to put in body copy, separate from whichever
          mailbox actually sends the message.
        </span>
      </label>

      <label className={labelCls}>
        Mailing address<span className="text-primary"> *</span>
        <textarea
          rows={2}
          placeholder="123 Main St, Suite 100, Miami, FL 33101"
          value={values.mailing_address}
          onChange={(e) => onChange({ ...values, mailing_address: e.target.value })}
          className={`${inputCls} resize-none py-2`}
        />
        <span className="text-xs text-muted-foreground/70">
          A real physical postal address — CAN-SPAM requires one in every commercial email. Appears in the
          unsubscribe footer of every Grow send.
        </span>
      </label>

      <div>
        <p className="mb-1.5 text-sm text-muted-foreground">Product links</p>
        <div className="flex flex-col gap-2">
          {values.product_urls.map((p, i) => (
            <div key={i} className="flex items-start gap-2">
              <input
                placeholder="Label, e.g. TestGuard"
                value={p.label}
                onChange={(e) => updateProduct(i, { label: e.target.value })}
                className={`${inputCls} sm:w-48`}
              />
              <input
                type="url"
                placeholder="https://example.com/product"
                value={p.url}
                onChange={(e) => updateProduct(i, { url: e.target.value })}
                className={inputCls}
              />
              <button
                type="button"
                onClick={() => removeProduct(i)}
                aria-label="Remove product link"
                className="mt-2 shrink-0 text-muted-foreground hover:text-destructive"
              >
                <Trash size={16} />
              </button>
            </div>
          ))}
        </div>
        <Button type="button" variant="ghost" onClick={addProduct} className="mt-2">
          <Plus size={14} weight="bold" className="mr-1.5 inline" /> Add product link
        </Button>
        <p className="mt-1.5 text-xs text-muted-foreground/70">
          Each label becomes a merge field: a product labeled &ldquo;TestGuard&rdquo; resolves{' '}
          {'{{product_url:TestGuard}}'}.
        </p>
      </div>
    </div>
  );
}

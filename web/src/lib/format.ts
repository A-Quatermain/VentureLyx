// Postgres numeric columns come back as strings (`sum(...)::text`) to avoid
// float precision loss over the wire — always parse before formatting.
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function formatMoney(value: string | number): string {
  const n = typeof value === 'string' ? Number(value) : value;
  return usd.format(Number.isFinite(n) ? n : 0);
}

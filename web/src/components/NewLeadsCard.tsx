import Link from 'next/link';
import type { Lead } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Row } from '@/components/ui/Row';
import { IconUsers } from '@/components/ui/icons';
import { toneSoft, type Tone } from '@/components/ui/tone';

const LIFECYCLE_CHIP: Record<string, { label: string; tone: Tone }> = {
  new: { label: 'New', tone: 'sun' },
  working: { label: 'In progress', tone: 'pool' },
  qualified: { label: 'Qualified', tone: 'growth' },
};

function relativeTime(iso: string | null): string {
  if (!iso) return 'No contact yet';
  const hours = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function NewLeadsCard({ leads }: { leads: Lead[] }) {
  return (
    <Card className="p-0">
      <div className="flex items-center justify-between p-4 pb-2">
        <p className="text-xs font-medium text-ink-3">NEW LEADS</p>
        <Link href="/operate" className="text-xs text-pool">
          Customers →
        </Link>
      </div>
      {leads.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-ink-2">
          No leads need attention right now — new and stale leads show up here.
        </p>
      ) : (
        <div className="divide-y divide-line-2">
          {leads.slice(0, 5).map((lead) => {
            const chip = LIFECYCLE_CHIP[lead.lifecycle] ?? { label: lead.lifecycle, tone: 'ink' as Tone };
            return (
              <Row
                key={lead.id}
                icon={<IconUsers width={16} height={16} />}
                tone="pool"
                title={lead.display_name}
                subtitle={[relativeTime(lead.last_activity_at), lead.channel, lead.city]
                  .filter(Boolean)
                  .join(' · ')}
                value={
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${toneSoft[chip.tone]}`}>
                    {chip.label}
                  </span>
                }
              />
            );
          })}
        </div>
      )}
    </Card>
  );
}

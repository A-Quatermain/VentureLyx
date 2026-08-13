import { Card } from '@/components/ui/Card';

export function ComingSoon({ module, description }: { module: string; description: string }) {
  return (
    <div className="p-4">
      <p className="font-display text-lg font-bold text-deepwater">{module}</p>
      <Card className="mt-4">
        <p className="text-sm text-ink">{description}</p>
        <p className="mt-1 text-sm text-ink-2">Not built yet — this is a placeholder route.</p>
      </Card>
    </div>
  );
}

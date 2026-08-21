import { Robot } from '@phosphor-icons/react/ssr';
import { LockedModulePage } from '@/components/LockedModulePage';

export default function AiTeamPage() {
  return (
    <LockedModulePage
      icon={Robot}
      label="AI Team"
      description="Receptionist, sales, SEO agents. A team of AI assistants working your business around the clock, each one accountable for a real job."
      bullets={[
        'A receptionist that answers and books jobs',
        'A sales assistant that follows up on leads',
        'An SEO agent that finds and fixes what is costing you customers',
      ]}
    />
  );
}

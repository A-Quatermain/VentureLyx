import { Compass } from '@phosphor-icons/react/ssr';
import { LockedModulePage } from '@/components/LockedModulePage';

export default function BuildPage() {
  return (
    <LockedModulePage
      icon={Compass}
      label="Build"
      description="Idea → blueprint → brand → site. Turn a business concept into a real brand and a working website, guided step by step."
      bullets={[
        'AI-drafted business blueprint',
        'Brand identity: name, logo direction, voice',
        'A generated starter site, ready to publish',
      ]}
    />
  );
}

import { Pill } from "@/components/ui/Pill";
import { PageHeading } from "@/components/ui/Surface";

export default function DraftHeader({
  title,
  status,
  subtitle,
}: {
  title: string;
  status: string;
  subtitle: string;
}) {
  return (
    <PageHeading
      title={title}
      subtitle={subtitle}
      actions={
        <Pill tone="warn" dot>
          {status}
        </Pill>
      }
    />
  );
}

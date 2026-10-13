import { Compass } from "lucide-react";
import { ButtonLink, EmptyState } from "@/components/ui";

export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16">
      <EmptyState icon={<Compass className="size-6" />} title="Page not found" body="The page you're looking for doesn't exist or you don't have access to it." action={<ButtonLink href="/">Back to events</ButtonLink>} />
    </main>
  );
}

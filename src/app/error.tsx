"use client";

import { RotateCcw } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16">
      <EmptyState
        title="Something went wrong"
        body={`We hit an unexpected error. Your bookings and tickets are safe. ${error.digest ? `(ref ${error.digest})` : ""}`}
        action={<Button onClick={reset}><RotateCcw className="size-4" aria-hidden /> Try again</Button>}
      />
    </main>
  );
}

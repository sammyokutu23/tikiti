import { Skeleton } from "@/components/ui";

export default function Loading() {
  return (
    <div className="mx-auto grid max-w-7xl gap-8 px-4 pt-4 sm:px-6 sm:pt-8 lg:grid-cols-[1fr_420px]" aria-busy="true">
      <div className="space-y-6">
        <Skeleton className="aspect-[16/10] w-full rounded-[2rem]" />
        <Skeleton className="h-9 w-3/4" />
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-28 w-full rounded-3xl" />
        <Skeleton className="h-28 w-full rounded-3xl" />
      </div>
    </div>
  );
}

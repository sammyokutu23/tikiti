import Image from "next/image";
import { Ticket } from "lucide-react";
import { eventImageSrc } from "@/lib/images";
import { cn } from "@/lib/utils";

export function EventImage({
  src,
  alt,
  width = 900,
  className,
  sizes = "(max-width: 640px) 100vw, 50vw",
  preload,
}: {
  src: string | null;
  alt: string;
  width?: number;
  className?: string;
  sizes?: string;
  preload?: boolean;
}) {
  const url = eventImageSrc(src, width);
  if (!url) {
    return (
      <div className={cn("flex items-center justify-center bg-gradient-to-br from-surface-3 to-surface", className)} role="img" aria-label={alt}>
        <Ticket className="size-10 text-subtle" aria-hidden />
      </div>
    );
  }
  return (
    <div className={cn("relative overflow-hidden bg-surface-2", className)}>
      <Image src={url} alt={alt} fill sizes={sizes} className="object-cover" preload={preload} />
    </div>
  );
}

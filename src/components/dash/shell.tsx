import type { ReactNode } from "react";
import { DashNav, type NavItem } from "./nav";

export function DashShell({ title, badge, items, children }: { title: string; badge?: ReactNode; items: NavItem[]; children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 pb-16 pt-5 sm:px-6 lg:flex-row lg:gap-10 lg:pt-8">
      <aside className="lg:w-56 lg:shrink-0">
        <div className="lg:sticky lg:top-24 lg:space-y-4">
          <div className="mb-3 flex items-center gap-2 lg:mb-0">
            <p className="text-sm font-semibold">{title}</p>
            {badge}
          </div>
          <DashNav items={items} />
        </div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

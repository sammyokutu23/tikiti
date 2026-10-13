export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <main className="flex flex-1 items-start justify-center px-4 pb-32 pt-10 sm:items-center sm:pt-16">{children}</main>;
}

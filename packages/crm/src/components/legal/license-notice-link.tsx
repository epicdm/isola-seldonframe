import Link from "next/link";

export function LicenseNoticeLink({ className = "" }: { className?: string }) {
  return (
    <Link href="/license" className={`text-xs text-muted-foreground underline-offset-4 hover:underline ${className}`}>
      Open-source notices · AGPL-3.0
    </Link>
  );
}

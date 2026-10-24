"use client";

export default function PersonalLinesError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 p-6" role="alert">
      <p className="text-sm text-muted-foreground">Workspace services</p>
      <h1 className="text-2xl font-semibold">Personal Lines are temporarily unavailable</h1>
      <p className="text-sm text-muted-foreground">Your workspace records were not changed. Try loading this view again.</p>
      <button type="button" onClick={reset} className="rounded-md border px-4 py-2 text-sm font-medium">
        Try again
      </button>
    </main>
  );
}

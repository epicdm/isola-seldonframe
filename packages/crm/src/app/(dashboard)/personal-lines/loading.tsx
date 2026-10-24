export default function PersonalLinesLoading() {
  return (
    <main aria-busy="true" className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div className="space-y-2">
        <div className="h-4 w-32 animate-pulse rounded bg-muted" />
        <div className="h-8 w-56 animate-pulse rounded bg-muted" />
      </div>
      <div className="h-10 max-w-xl animate-pulse rounded-md bg-muted" />
      <div className="space-y-3 rounded-lg border p-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-10 animate-pulse rounded bg-muted" />
        ))}
      </div>
      <span className="sr-only">Loading Personal Lines</span>
    </main>
  );
}

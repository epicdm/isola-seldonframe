// Honest 404 for the public form route: an unknown form slug, or a bare
// /intake on a workspace that has no public default intake form. It never
// falls back to another (possibly internal) form.
export default function FormNotAvailable() {
  return (
    <main className="crm-page flex flex-col items-center px-4 pt-16 text-center">
      <h1 className="text-lg font-semibold">This form is not available</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        The form you are looking for does not exist or is not published. Please contact the business directly.
      </p>
    </main>
  );
}

// Shown immediately while the page reads Meta and the voice platform live (a few seconds). Static: no data, no inputs.
export default function PhoneWhatsappLoading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-live="polite" data-testid="phone-whatsapp-loading">
      <div>
        <h1 className="text-page-title">Phone &amp; WhatsApp</h1>
        <p className="mt-2 text-sm text-muted-foreground">Reading live status from Meta and the EPIC voice platform. This can take up to ten seconds.</p>
      </div>
      <section className="crm-card animate-pulse space-y-3 p-4" aria-hidden="true">
        <div className="h-5 w-48 rounded bg-muted" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-10 rounded bg-muted" />
        ))}
      </section>
    </div>
  );
}

export function LoadingState({ label = 'Daten werden geladen …' }: { label?: string }) {
  return <div className="loading-state" role="status" aria-live="polite">
    <span className="sr-only">{label}</span>
    <div className="skeleton skeleton-line" aria-hidden="true" />
    <div className="skeleton skeleton-line" aria-hidden="true" />
    <div className="skeleton skeleton-line" aria-hidden="true" />
  </div>;
}

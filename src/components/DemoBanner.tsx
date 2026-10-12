import type { StatusResponse } from '@shared/api';

export function DemoBanner({ status }: { status?: StatusResponse | null }) {
  if (status?.marketData.mode !== 'demo') return null;
  return <div className="demo-banner" role="note"><span aria-hidden="true">◈</span> <strong>Demo – keine echten Marktdaten</strong><span>Zum Kennenlernen der Anwendung.</span></div>;
}

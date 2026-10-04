import { useEffect, useState } from 'react';
import { useVisitStats, type VisitStats } from '../../analytics/client';

const format = new Intl.NumberFormat('en');

/** Records this page view with the analytics module; with `counter`, shows the site totals linked to the dashboard. */
export default function Visits({ path, counter = false }: { path: string; counter?: boolean }) {
  const stats = useVisitStats(path);
  const [publicStats, setPublicStats] = useState<VisitStats | null>(null);

  // Reading public totals does not record a visit. It also works when tracking is
  // skipped (e.g. Do Not Track) or the hit request fails.
  useEffect(() => {
    if (!counter) return;
    const controller = new AbortController();
    void fetch('/api/stats', { credentials: 'omit', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const totals = await response.json();
        if (totals?.scope === 'all' && Number.isSafeInteger(totals.uv) && totals.uv >= 0
          && Number.isSafeInteger(totals.pv) && totals.pv >= 0) {
          setPublicStats(totals);
        }
      })
      .catch(() => { /* Keep the placeholder while totals are unavailable. */ });
    return () => controller.abort();
  }, [path, counter]);

  if (!counter) return null;
  const totals = stats ?? publicStats;

  return (
    <a className="visitors" href="/analytics/" title="Open visitor analytics">
      {totals ? format.format(totals.uv) : '—'} visitors · {totals ? format.format(totals.pv) : '—'} views
    </a>
  );
}

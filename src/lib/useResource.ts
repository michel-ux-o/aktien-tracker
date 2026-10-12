import { useCallback, useEffect, useRef, useState } from 'react';

/** Lädt erneut nach Änderungen; Hintergrundabrufe finden höchstens alle fünf Minuten im sichtbaren Tab statt. */
export function useResource<T>(loader: () => Promise<T>, deps: readonly unknown[] = [], options: { refreshInterval?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const lastLoaded = useRef(Date.now());
  const reload = useCallback(() => setVersion(value => value + 1), []);
  useEffect(() => { setData(null); }, deps);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    loaderRef.current().then(value => { if (active) setData(value); }).catch((reason: unknown) => { if (active) setError(reason); }).finally(() => {
      if (active) { setLoading(false); lastLoaded.current = Date.now(); }
    });
    return () => { active = false; };
  }, [version, ...deps]);
  const interval = options.refreshInterval ? Math.max(300_000, options.refreshInterval) : 0;
  useEffect(() => {
    if (!interval) return;
    const refresh = () => { if (document.visibilityState === 'visible' && Date.now() - lastLoaded.current >= interval) reload(); };
    const timer = window.setInterval(refresh, interval);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [interval, reload]);
  return { data, loading, error, reload };
}

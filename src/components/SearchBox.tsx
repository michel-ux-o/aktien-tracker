import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DataMeta, Instrument } from '@shared/types';
import { api, errorMessage } from '../api/client';
import { instrumentPath } from '../lib/format';
import { DataSourceNote } from './DataSourceNote';

export function SearchBox({ onSelect, autoFocus = false, placeholder = 'Aktie oder Ticker suchen', initialQuery = '', showResults = false, label = 'Aktie suchen', error, disabled = false }: {
  onSelect?: (instrument: Instrument) => void; autoFocus?: boolean; placeholder?: string; initialQuery?: string; showResults?: boolean; label?: string; error?: string; disabled?: boolean;
}) {
  const navigate = useNavigate();
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-results`;
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<Instrument[]>([]);
  const [meta, setMeta] = useState<DataMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [requestError, setRequestError] = useState<unknown>(null);
  const [focused, setFocused] = useState(autoFocus);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [retry, setRetry] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const selectedQuery = useRef<string | null>(null);
  const normalized = query.trim();
  const expanded = !disabled && (showResults || focused) && normalized.length > 0 && selectedQuery.current !== query;

  useEffect(() => {
    const abort = new AbortController();
    setActiveIndex(-1); setResults([]); setMeta(null); setRequestError(null); setSearched(false);
    if (!normalized || selectedQuery.current === query || disabled) { setLoading(false); return; }
    setLoading(true);
    const timer = window.setTimeout(() => {
      void api.search(normalized, abort.signal).then(response => {
        if (abort.signal.aborted) return;
        setResults(response.results); setMeta(response.meta); setSearched(true); setLoading(false);
      }).catch(failure => {
        if (abort.signal.aborted) return;
        setRequestError(failure); setSearched(true); setLoading(false);
      });
    }, 300);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [normalized, query, retry, disabled]);

  useEffect(() => {
    const onOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setFocused(false);
    };
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, []);

  useEffect(() => {
    if (activeIndex >= 0) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, id]);

  const select = (instrument: Instrument) => {
    setFocused(false); setActiveIndex(-1);
    if (onSelect) { selectedQuery.current = instrument.name; setQuery(instrument.name); setResults([]); onSelect(instrument); }
    else { setQuery(''); navigate(instrumentPath(instrument.id)); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setFocused(true);
      if (results.length) setActiveIndex(index => event.key === 'ArrowDown' ? (index + 1) % results.length : index <= 0 ? results.length - 1 : index - 1);
    } else if (event.key === 'Escape' && expanded && !showResults) {
      event.preventDefault(); event.stopPropagation(); setFocused(false); setActiveIndex(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const instrument = results[activeIndex >= 0 ? activeIndex : 0];
      if (expanded && instrument) select(instrument);
      else if (!onSelect && normalized) { setFocused(false); navigate(`/suche?q=${encodeURIComponent(normalized)}`); }
    }
  };

  return <div className={`search-box${showResults ? ' search-box-page' : ''}`} ref={root}>
    <label htmlFor={inputId}>{label}</label>
    <input id={inputId} ref={input} className="search-input" type="search" value={query} autoFocus={autoFocus} data-autofocus={autoFocus || undefined} disabled={disabled}
      placeholder={placeholder} autoComplete="off" spellCheck={false} role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={listId} aria-activedescendant={expanded && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
      aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
      onFocus={() => setFocused(true)} onChange={event => { selectedQuery.current = null; setQuery(event.target.value); setFocused(true); }} onKeyDown={onKeyDown}
      onBlur={() => { window.setTimeout(() => { if (!root.current?.contains(document.activeElement)) { setFocused(false); setActiveIndex(-1); } }, 0); }} />
    {error && <p id={`${id}-error`} className="field-error" aria-live="polite">{error}</p>}
    {expanded && <div className={`search-results${showResults ? ' search-results-inline' : ''}`}>
      <div className="search-status" role="status" aria-live="polite">{loading ? 'Aktien werden gesucht …' : requestError != null ? errorMessage(requestError) : searched ? `${results.length} Treffer${results.length === 0 ? '. Versuche einen anderen Namen oder Ticker.' : '. Mit den Pfeiltasten auswählen und mit Enter öffnen.'}` : ''}</div>
      {requestError != null && <button type="button" className="button button-secondary" onClick={() => setRetry(value => value + 1)}>Erneut versuchen</button>}
      <ul id={listId} role="listbox" aria-label="Gefundene Wertpapiere">{results.map((instrument, index) => <li key={instrument.id} id={`${id}-option-${index}`} role="option" aria-selected={index === activeIndex} className={`search-option${index === activeIndex ? ' is-active' : ''}`}
        onMouseDown={event => event.preventDefault()} onClick={() => select(instrument)}>
        <strong>{instrument.name}</strong><span>{instrument.symbol} · {instrument.exchange} · {instrument.currency}</span>
      </li>)}</ul>
      {meta && <DataSourceNote meta={meta} />}
      {!showResults && !onSelect && results.length > 0 && <Link className="search-all" to={`/suche?q=${encodeURIComponent(normalized)}`} onClick={() => setFocused(false)}>Alle Treffer ansehen →</Link>}
    </div>}
  </div>;
}

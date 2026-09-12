export function compactNumber(v: number | string | bigint | null | undefined): string {
  if (v == null || v === '') return '—';
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function fullNumber(v: number | string | bigint | null | undefined): string {
  if (v == null || v === '') return '—';
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en').format(n);
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function relDate(d: Date | string | null | undefined): string {
  if (!d) return 'never';
  const date = typeof d === 'string' ? new Date(d) : d;
  const diff = Date.now() - date.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return date.toISOString().slice(0, 10);
}

export function usd(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v > 0 && v < 0.01) return '<$0.01';
  return `$${v.toLocaleString('en', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function ms(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  return `${Math.round(v / 60_000)}m ${Math.round((v % 60_000) / 1000)}s`;
}

export function bytes(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = v;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)}${units[i]}`;
}

export function ratioPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

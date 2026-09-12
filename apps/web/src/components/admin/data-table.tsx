import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@growth-agent/ui';

export interface Column<Row> {
  key: string;
  header: string;
  cell: (row: Row) => ReactNode;
  className?: string;
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  empty = 'Nothing to show.',
}: {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  empty?: string;
}) {
  if (rows.length === 0) {
    return <p className="text-muted-foreground py-8 text-center text-sm">{empty}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-muted-foreground border-border border-b">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn('px-2 py-2 font-medium', c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-border/60 border-b align-top last:border-0">
              {columns.map((c) => (
                <td key={c.key} className={cn('px-2 py-2', c.className)}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Prev / next links that preserve the current query string. */
export function Pager({
  basePath,
  page,
  pageCount,
  total,
  searchParams,
}: {
  basePath: string;
  page: number;
  pageCount: number;
  total: number;
  searchParams: Record<string, string | undefined>;
}) {
  const href = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (v != null && k !== 'page') params.set(k, v);
    }
    params.set('page', String(p));
    return `${basePath}?${params.toString()}`;
  };
  return (
    <div className="text-muted-foreground mt-3 flex items-center justify-between text-xs">
      <span>
        Page {page} of {pageCount} · {total} total
      </span>
      <span className="flex gap-2">
        {page > 1 ? (
          <Link href={href(page - 1)} className="hover:text-foreground underline">
            ← Prev
          </Link>
        ) : (
          <span className="opacity-40">← Prev</span>
        )}
        {page < pageCount ? (
          <Link href={href(page + 1)} className="hover:text-foreground underline">
            Next →
          </Link>
        ) : (
          <span className="opacity-40">Next →</span>
        )}
      </span>
    </div>
  );
}

import { describe, expect, it } from 'vitest';
import { cn } from './cn.js';

describe('cn', () => {
  it('merges and dedupes tailwind classes', () => {
    const hidden = false as boolean;
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-sm', hidden && 'hidden', 'font-medium')).toBe('text-sm font-medium');
  });
});

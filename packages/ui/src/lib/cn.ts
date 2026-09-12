import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind class names, resolving conflicts left-to-right. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

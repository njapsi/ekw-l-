import type { Config } from 'tailwindcss';
import preset from '@growth-agent/ui/tailwind-preset';

export default {
  presets: [preset],
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
} satisfies Config;

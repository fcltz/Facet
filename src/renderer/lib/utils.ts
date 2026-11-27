import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** "#5B5BF7" + 0.12 → "#5B5BF71F" (cor com transparência para fundos e bordas suaves). */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
  return `${hex}${a.toString(16).padStart(2, '0')}`
}

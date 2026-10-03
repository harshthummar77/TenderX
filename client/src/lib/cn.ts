import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * `cn('px-2 text-muted', isActive && 'text-primary')` — clsx for conditionals,
 * tailwind-merge so a prop-supplied class actually wins over a component's
 * default instead of landing in a coin flip.
 */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

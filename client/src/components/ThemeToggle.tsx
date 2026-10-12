import { Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useThemeStore } from '@/stores/themeStore';

/**
 * The one theme switch, reused in the landing header and the app topbar. Reads
 * the resolved mode so the icon always shows what you would get by clicking.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const resolved = useThemeStore((state) => state.resolved);
  const toggle = useThemeStore((state) => state.toggle);
  const next = resolved === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={cn(
        'rounded-md p-2 text-muted transition-colors hover:bg-subtle hover:text-text',
        className,
      )}
    >
      {resolved === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

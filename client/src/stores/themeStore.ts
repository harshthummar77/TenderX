import { create } from 'zustand';

/**
 * App-wide light/dark theme (landing page and every module).
 *
 * The actual colours live in `index.css` as token swaps keyed on
 * `data-theme` / `prefers-color-scheme` — this store only decides which mode is
 * active and writes the attribute. `system` means "no stored preference": the
 * attribute is removed and the media query governs, so the app follows the OS
 * live. A no-flash inline script in `index.html` sets the same attribute before
 * first paint; the initial state here mirrors it exactly.
 */

type Theme = 'light' | 'dark' | 'system';
type Resolved = 'light' | 'dark';

const KEY = 'tb.theme';
const mql = () => window.matchMedia('(prefers-color-scheme: dark)');

function readStored(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function resolve(theme: Theme): Resolved {
  return theme === 'system' ? (mql().matches ? 'dark' : 'light') : theme;
}

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = theme;
}

interface ThemeState {
  theme: Theme;
  /** What is actually on screen — what the toggle icon reflects. */
  resolved: Resolved;
  setTheme: (theme: Theme) => void;
  /** Header button: flip the visible mode, leaving `system` behind. */
  toggle: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: readStored(),
  resolved: resolve(readStored()),
  setTheme: (theme) => {
    apply(theme);
    try {
      if (theme === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {
      /* private mode — the attribute still applied, only persistence is lost */
    }
    set({ theme, resolved: resolve(theme) });
  },
  toggle: () => get().setTheme(get().resolved === 'dark' ? 'light' : 'dark'),
}));

// Follow the OS while no explicit preference is stored.
if (typeof window !== 'undefined') {
  mql().addEventListener('change', () => {
    if (useThemeStore.getState().theme === 'system') {
      useThemeStore.setState({ resolved: resolve('system') });
    }
  });
}

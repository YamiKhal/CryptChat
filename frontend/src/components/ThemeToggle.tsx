import { Moon, Sun } from 'lucide-react';
import { useTheme, toggleTheme } from '../lib/theme';

/**
 * Dark/light switch.
 *
 * Shows the icon of the theme you'd switch TO, which is the convention people
 * expect from a single-button toggle: a moon means "go dark", a sun means "go
 * light". The accessible label spells it out so it isn't icon-only.
 */
export default function ThemeToggle({ className = '' }: { className?: string }) {
  const theme = useTheme();
  const goingTo = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      onClick={() => toggleTheme()}
      className={`px-3 py-1.5 t-base hover:text-primary cursor-pointer ${className}`}
      aria-label={`Switch to ${goingTo} theme`}
      title={`Switch to ${goingTo} theme`}
    >
      {theme === 'dark' ? (
        <Sun size={18} aria-hidden="true" />
      ) : (
        <Moon size={18} aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * @file The application shell: sidebar, header, theme toggle.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Database,
  FileClock,
  LayoutDashboard,
  Moon,
  Plus,
  ScrollText,
  Settings as SettingsIcon,
  Sun,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, TooltipProvider } from '@/components/ui/primitives';

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: React.ComponentType<{ className?: string }>;
  /** Match nested routes too (e.g. /migrations/:id under "Migration History"). */
  readonly prefix?: boolean;
}

const NAV: readonly NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/migrations/new', label: 'New Migration', icon: Plus },
  { href: '/migrations', label: 'Migration History', icon: FileClock, prefix: true },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
  { href: '/logs', label: 'Logs', icon: ScrollText },
];

export function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname();

  const isActive = (item: NavItem): boolean => {
    if (item.href === '/migrations/new') return pathname === '/migrations/new';
    if (item.prefix === true) return pathname.startsWith(item.href) && pathname !== '/migrations/new';
    return pathname === item.href;
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--glass-bg)] backdrop-blur-xl lg:flex">
          <div className="flex items-center gap-2.5 px-5 py-5">
            <div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-accent-500)] shadow-lg shadow-[var(--color-brand-600)]/25">
              <Database className="size-[18px] text-white" strokeWidth={2.2} />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight">Nebkern</div>
              <div className="text-[11px] text-[var(--fg-subtle)]">Migration Tool</div>
            </div>
          </div>

          <nav className="flex-1 space-y-0.5 px-3 py-2">
            {NAV.map((item) => {
              const active = isActive(item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                    active
                      ? 'bg-[var(--color-brand-500)]/12 font-medium text-[var(--fg)]'
                      : 'text-[var(--fg-muted)] hover:bg-[var(--glass-hover)] hover:text-[var(--fg)]',
                  )}
                >
                  {active && (
                    <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[var(--color-brand-500)]" />
                  )}
                  <item.icon
                    className={cn('size-[18px]', active ? 'text-[var(--info)]' : 'text-[var(--fg-subtle)]')}
                  />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="border-t border-[var(--line)] p-3">
            <ThemeToggle />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile top bar. The sidebar is desktop-only; this keeps navigation
              reachable without building a full drawer for a tool that is realistically
              used on a laptop. */}
          <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-[var(--line)] bg-[var(--glass-bg)] px-4 py-3 backdrop-blur-xl lg:hidden">
            <div className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-[var(--color-brand-500)] to-[var(--color-accent-500)]">
              <Database className="size-4 text-white" />
            </div>
            <span className="text-sm font-semibold">Nebkern</span>
            <nav className="ml-auto flex items-center gap-1 overflow-x-auto">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-label={item.label}
                  className={cn(
                    'rounded-lg p-2 transition-colors',
                    isActive(item)
                      ? 'bg-[var(--color-brand-500)]/12 text-[var(--info)]'
                      : 'text-[var(--fg-subtle)] hover:bg-[var(--glass-hover)]',
                  )}
                >
                  <item.icon className="size-[18px]" />
                </Link>
              ))}
            </nav>
          </header>

          <main className="flex-1 px-5 py-6 sm:px-8 sm:py-8">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * The theme lives on `<html>`, where the inline script in `layout.tsx` puts it before
 * first paint. That makes the DOM — not React — the source of truth, so the toggle
 * reads it through `useSyncExternalStore` rather than mirroring it into state inside
 * an effect. Mirroring would render once with a guessed value and then again with the
 * real one, which is both a wasted render and a visible flicker on a control whose
 * entire job is to show the current theme.
 */
const themeListeners = new Set<() => void>();

function subscribeToTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

/** Dark is the server-rendered default, matching what the inline script assumes. */
function isDarkOnServer(): boolean {
  return true;
}

function ThemeToggle(): React.JSX.Element {
  const dark = React.useSyncExternalStore(subscribeToTheme, isDark, isDarkOnServer);

  const toggle = (): void => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('nebkern-theme', next ? 'dark' : 'light');
    } catch {
      // Private browsing with storage disabled — the toggle still works for this session.
    }
    for (const listener of themeListeners) listener();
  };

  return (
    <Button variant="ghost" size="sm" onClick={toggle} className="w-full justify-start gap-2.5 px-3">
      {dark ? <Moon className="size-[18px]" /> : <Sun className="size-[18px]" />}
      {dark ? 'Dark' : 'Light'} mode
    </Button>
  );
}

/** Page header with title, subtitle and optional actions. Used by every page. */
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description !== undefined && <p className="text-sm text-[var(--fg-muted)]">{description}</p>}
      </div>
      {children !== undefined && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

/** A small labelled metric tile. The dashboard and discovery step are built from these. */
export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: 'neutral' | 'brand' | 'ok' | 'warn' | 'danger';
}): React.JSX.Element {
  const toneColour = {
    neutral: 'text-[var(--fg-subtle)]',
    brand: 'text-[var(--info)]',
    ok: 'text-[var(--ok)]',
    warn: 'text-[var(--warn)]',
    danger: 'text-[var(--danger)]',
  }[tone];

  return (
    <div className="glass glass-sheen glass-hover p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--fg-subtle)]">{label}</span>
        {Icon !== undefined && <Icon className={cn('size-4', toneColour)} />}
      </div>
      <div className="tabular mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      {hint !== undefined && <div className="mt-0.5 text-xs text-[var(--fg-subtle)]">{hint}</div>}
    </div>
  );
}

export { Activity };

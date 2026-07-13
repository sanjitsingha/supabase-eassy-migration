/**
 * @file Root layout.
 */

import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Toaster } from 'sonner';
import { Shell } from '@/components/app/shell';
import './globals.css';

// The CSS variables are named after the typefaces, not after the Tailwind roles.
// `globals.css` maps them onto `--font-sans` / `--font-mono` in its `@theme` block;
// pointing them straight at the role names would make that mapping self-referential.
const sans = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' });

export const metadata: Metadata = {
  title: 'Nebkern Migration Tool',
  description:
    'Migrate an entire Supabase project — schema, data, storage, auth and edge functions — between Cloud and self-hosted instances.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1115' },
  ],
};

/**
 * Applies the stored theme before first paint.
 *
 * Runs synchronously in <head>, ahead of React hydrating. Without it the page renders
 * light and then snaps to dark once the client mounts — the "flash of wrong theme"
 * that no amount of CSS can fix, because the preference lives in localStorage and the
 * server cannot see it.
 */
const THEME_SCRIPT = `
(function() {
  try {
    var stored = localStorage.getItem('nebkern-theme');
    document.documentElement.classList.toggle('dark', stored ? stored === 'dark' : true);
  } catch (e) {
    document.documentElement.classList.add('dark');
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className={`${sans.variable} ${mono.variable} font-sans antialiased`}>
        <Shell>{children}</Shell>
        <Toaster
          position="bottom-right"
          toastOptions={{
            classNames: {
              toast: 'glass !border-[var(--line)] !text-[var(--fg)]',
              description: '!text-[var(--fg-muted)]',
            },
          }}
        />
      </body>
    </html>
  );
}

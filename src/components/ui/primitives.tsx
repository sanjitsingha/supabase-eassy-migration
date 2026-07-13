/**
 * @file The shadcn/ui primitives this application uses.
 *
 * Kept in one file rather than fifteen: they are small, they share the same token
 * vocabulary, and having them together makes the design system legible at a glance.
 * Each is a thin, accessible wrapper over a Radix primitive (or a plain element
 * where Radix has nothing to add), styled with the glass tokens from `globals.css`.
 */

'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as LabelPrimitive from '@radix-ui/react-label';
import * as SeparatorPrimitive from '@radix-ui/react-separator';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cva, type VariantProps } from 'class-variance-authority';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.98]',
  {
    variants: {
      variant: {
        primary:
          'bg-gradient-to-b from-[var(--color-brand-500)] to-[var(--color-brand-600)] text-white shadow-lg shadow-[var(--color-brand-600)]/25 hover:brightness-110',
        accent:
          'bg-gradient-to-b from-[var(--color-accent-500)] to-[var(--color-accent-600)] text-[oklch(0.15_0.02_265)] font-semibold shadow-lg shadow-[var(--color-accent-600)]/25 hover:brightness-110',
        outline:
          'border border-[var(--line)] bg-[var(--glass-bg)] backdrop-blur-md hover:bg-[var(--glass-hover)] hover:border-[var(--color-brand-500)]/40',
        ghost: 'hover:bg-[var(--glass-hover)] text-[var(--fg-muted)] hover:text-[var(--fg)]',
        danger: 'bg-[var(--danger)] text-white hover:brightness-110 shadow-lg shadow-[var(--danger)]/25',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4',
        lg: 'h-11 px-6 text-[0.95rem]',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, children, disabled, ...props }, ref) => {
    const Component = asChild ? Slot : 'button';

    return (
      <Component
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled === true || loading}
        {...props}
      >
        {loading ? (
          <>
            <Loader2 className="animate-spin" />
            {children}
          </>
        ) : (
          children
        )}
      </Component>
    );
  },
);
Button.displayName = 'Button';

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('glass glass-sheen', className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('flex flex-col gap-1 p-5 pb-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  return <h3 className={cn('text-base font-semibold tracking-tight', className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return <p className={cn('text-sm text-[var(--fg-muted)]', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('p-5 pt-0', className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('flex items-center gap-2 p-5 pt-0', className)} {...props} />;
}

// ---------------------------------------------------------------------------
// Input / Textarea / Label
// ---------------------------------------------------------------------------

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--input-bg)] px-3 py-2 text-sm',
        'placeholder:text-[var(--fg-subtle)] backdrop-blur-md transition-colors',
        'focus-visible:border-[var(--color-brand-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-500)]/25',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn('text-sm font-medium leading-none text-[var(--fg)] peer-disabled:opacity-60', className)}
    {...props}
  />
));
Label.displayName = 'Label';

// ---------------------------------------------------------------------------
// Checkbox / Radio / Switch
// ---------------------------------------------------------------------------

export const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'peer size-[18px] shrink-0 rounded-[5px] border border-[var(--line)] bg-[var(--input-bg)] transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-500)]/40',
      'data-[state=checked]:border-[var(--color-brand-500)] data-[state=checked]:bg-[var(--color-brand-500)] data-[state=checked]:text-white',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      <Check className="size-3.5" strokeWidth={3} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = 'Checkbox';

export const RadioGroup = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root ref={ref} className={cn('grid gap-2', className)} {...props} />
));
RadioGroup.displayName = 'RadioGroup';

export const RadioGroupItem = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      'aspect-square size-[18px] rounded-full border border-[var(--line)] bg-[var(--input-bg)] transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-500)]/40',
      'data-[state=checked]:border-[var(--color-brand-500)]',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  >
    <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
      <span className="size-2 rounded-full bg-[var(--color-brand-500)]" />
    </RadioGroupPrimitive.Indicator>
  </RadioGroupPrimitive.Item>
));
RadioGroupItem.displayName = 'RadioGroupItem';

export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-[22px] w-[40px] shrink-0 cursor-pointer items-center rounded-full border border-[var(--line)] transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-500)]/40',
      'data-[state=checked]:bg-[var(--color-brand-500)] data-[state=unchecked]:bg-[var(--input-bg)]',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block size-[16px] translate-x-[2px] rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[20px]" />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      tone: {
        neutral: 'border-[var(--line)] bg-[var(--glass-bg)] text-[var(--fg-muted)]',
        brand: 'border-[var(--color-brand-500)]/30 bg-[var(--color-brand-500)]/12 text-[var(--info)]',
        ok: 'border-[var(--ok)]/30 bg-[var(--ok)]/12 text-[var(--ok)]',
        warn: 'border-[var(--warn)]/30 bg-[var(--warn)]/12 text-[var(--warn)]',
        danger: 'border-[var(--danger)]/30 bg-[var(--danger)]/12 text-[var(--danger)]',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface ProgressProps {
  /** 0–100. Pass `null` for an indeterminate bar (total not yet known). */
  value: number | null;
  className?: string;
  barClassName?: string;
}

export function Progress({ value, className, barClassName }: ProgressProps): React.JSX.Element {
  const indeterminate = value === null;

  return (
    <div
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        'relative h-2 w-full overflow-hidden rounded-full bg-[var(--line)]',
        className,
      )}
    >
      {indeterminate ? (
        <div className="absolute inset-y-0 w-1/3 animate-shimmer rounded-full bg-gradient-to-r from-transparent via-[var(--color-brand-500)] to-transparent" />
      ) : (
        <div
          className={cn(
            'h-full rounded-full bg-gradient-to-r from-[var(--color-brand-500)] to-[var(--color-accent-500)] transition-[width] duration-500 ease-out',
            barClassName,
          )}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Separator / Tooltip
// ---------------------------------------------------------------------------

export const Separator = React.forwardRef<
  React.ComponentRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = 'horizontal', decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn(
      'shrink-0 bg-[var(--line)]',
      orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
      className,
    )}
    {...props}
  />
));
Separator.displayName = 'Separator';

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 max-w-xs rounded-lg border border-[var(--line)] bg-[var(--glass-bg)] px-3 py-1.5 text-xs text-[var(--fg)] shadow-xl backdrop-blur-xl',
        'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = 'TooltipContent';

// ---------------------------------------------------------------------------
// Field — a label + control + hint + error, the shape every form row takes
// ---------------------------------------------------------------------------

export interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
}

export function Field({ label, htmlFor, hint, error, required, children }: FieldProps): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={htmlFor}>
          {label}
          {required === true && <span className="ml-0.5 text-[var(--danger)]">*</span>}
        </Label>
        {hint !== undefined && <span className="text-xs text-[var(--fg-subtle)]">{hint}</span>}
      </div>
      {children}
      {error !== undefined && error !== null && error !== '' && (
        <p className="text-xs text-[var(--danger)]">{error}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

/**
 * A native `<select>` rather than the Radix listbox.
 *
 * Deliberate: every select in this app is a short list of fixed technical options
 * (SSL mode, pooler mode). A native control gets keyboard behaviour, mobile pickers
 * and form semantics for free, and does not add a portal + focus trap to a form the
 * user is tabbing through quickly.
 */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement> & { options: readonly SelectOption[] }
>(({ className, options, ...props }, ref) => (
  <div className="relative">
    <select
      ref={ref}
      className={cn(
        'flex h-10 w-full appearance-none rounded-lg border border-[var(--line)] bg-[var(--input-bg)] px-3 py-2 pr-9 text-sm',
        'backdrop-blur-md transition-colors',
        'focus-visible:border-[var(--color-brand-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-500)]/25',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[var(--fg-subtle)]" />
  </div>
));
Select.displayName = 'Select';

// ---------------------------------------------------------------------------
// Collapsible section
// ---------------------------------------------------------------------------

export function Collapsible({
  title,
  description,
  icon: Icon,
  open,
  onOpenChange,
  badge,
  children,
}: {
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  badge?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--input-bg)]">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left transition-colors hover:bg-[var(--glass-hover)] rounded-xl"
      >
        <ChevronDown
          className={cn('size-4 shrink-0 text-[var(--fg-subtle)] transition-transform', open && 'rotate-180')}
        />
        {Icon !== undefined && <Icon className="size-4 shrink-0 text-[var(--fg-subtle)]" />}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{title}</div>
          {description !== undefined && (
            <div className="mt-0.5 text-xs text-[var(--fg-subtle)]">{description}</div>
          )}
        </div>
        {badge}
      </button>

      {open && <div className="space-y-4 border-t border-[var(--line)] p-3.5">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--glass-bg)] p-3.5">
        <Icon className="size-6 text-[var(--fg-subtle)]" />
      </div>
      <div className="space-y-1">
        <h3 className="font-semibold">{title}</h3>
        <p className="mx-auto max-w-sm text-sm text-[var(--fg-muted)]">{description}</p>
      </div>
      {action}
    </div>
  );
}

// Small building blocks shared across the app.

import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { bytes, savings } from '@/lib/format';

/** The three-squares mark. `working` plays the squeeze animation. */
export function Logo({ className, working = false }: { className?: string; working?: boolean }) {
  return (
    <svg className={cn('size-5', className)} viewBox="0 0 100 100" fill="none" aria-hidden="true">
      {working && (
        <style>{`
          .mvs-box { transform-box: fill-box; transform-origin: center; animation: mvs-squeeze 2.4s cubic-bezier(.65,0,.35,1) infinite; }
          .mvs-box:nth-of-type(2) { animation-delay: .15s; }
          .mvs-box:nth-of-type(3) { animation-delay: .3s; }
          @keyframes mvs-squeeze { 0%, 100% { transform: scale(1); } 50% { transform: scale(.78); } }
        `}</style>
      )}
      <rect className="mvs-box" x="14" y="46" width="32" height="32" stroke="currentColor" strokeWidth="6" strokeLinejoin="round" />
      <rect className="mvs-box" x="54" y="46" width="32" height="32" stroke="currentColor" strokeWidth="6" strokeLinejoin="round" />
      <rect className="mvs-box" x="34" y="18" width="32" height="32" stroke="currentColor" strokeWidth="6" strokeLinejoin="round" />
    </svg>
  );
}

/** A labelled setting: label on the left, control on the right, optional help below. */
export function Field({
  label,
  hint,
  children,
  className,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn('grid grid-cols-[148px_minmax(0,1fr)] items-start gap-x-4 py-2', className)}>
      <label htmlFor={htmlFor} className="pt-1.5 text-muted-foreground">
        {label}
      </label>
      <div className="min-w-0">
        {children}
        {hint && <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

/** A row of mutually exclusive choices. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-md border bg-muted p-0.5', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cn(
            'h-7 rounded-[5px] px-3 text-[13px] whitespace-nowrap text-muted-foreground transition-colors outline-none',
            'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40',
            value === option.value && 'bg-raised text-foreground shadow-sm',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Wrap anything in a tooltip. */
export function Tip({ text, children, side }: { text: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{text}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The shrink meter: the full bar is the source file, the filled part is the
 * result. It is the one piece of the interface that shows what the app is for.
 */
export function ShrinkMeter({
  sourceBytes,
  outputBytes,
  state,
  className,
  compact = false,
}: {
  sourceBytes: number;
  /** Estimated or final size; null when unknown. */
  outputBytes: number | null;
  /** `estimate` draws in saffron, `final` in teal, `live` animates while encoding. */
  state: 'unknown' | 'estimate' | 'live' | 'final';
  className?: string;
  compact?: boolean;
}) {
  const known = outputBytes !== null && sourceBytes > 0;
  const ratio = known ? Math.min(1, Math.max(0.015, outputBytes / sourceBytes)) : 0;
  const grew = known && outputBytes > sourceBytes;
  const pct = known ? savings(sourceBytes, outputBytes) : 0;
  const fill = grew ? 'bg-destructive' : state === 'final' ? 'bg-saved' : 'bg-primary';

  return (
    <div className={className}>
      <div
        className={cn('relative w-full overflow-hidden rounded-[3px] bg-accent', compact ? 'h-1.5' : 'h-2.5')}
        role="img"
        aria-label={known ? `${bytes(outputBytes)} of ${bytes(sourceBytes)}` : `Source is ${bytes(sourceBytes)}; result size not known yet`}
      >
        <div
          className={cn('h-full rounded-[3px] transition-[width] duration-500 ease-out', fill, state === 'live' && 'animate-pulse')}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      {!compact && (
        <div className="readout mt-1.5 flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">
            {bytes(sourceBytes)}
            <span className="mx-1.5 text-faint">to</span>
            <span className={cn(known ? 'text-foreground' : 'text-faint')}>
              {known ? `${state === 'estimate' ? 'about ' : ''}${bytes(outputBytes)}` : 'not estimated yet'}
            </span>
          </span>
          {known && (
            <span className={cn('font-medium', grew ? 'text-destructive' : state === 'final' ? 'text-saved' : 'text-primary')}>
              {pct > 0 ? `${pct}% smaller` : pct < 0 ? `${-pct}% larger` : 'same size'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** A quiet block for "nothing here yet" states. */
export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="text-faint [&_svg]:size-9">{icon}</div>
      <p className="text-[15px] font-medium text-foreground">{title}</p>
      {children && <div className="max-w-[34ch] text-muted-foreground">{children}</div>}
    </div>
  );
}

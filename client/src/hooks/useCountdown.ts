import { useEffect, useState } from 'react';

export type CountdownSeverity = 'normal' | 'warning' | 'critical' | 'expired';

export interface Countdown {
  /** Milliseconds left; 0 once the deadline has passed. */
  remainingMs: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** "HH:MM:SS", or "2d 04:15:09" once more than a day is left. */
  label: string;
  expired: boolean;
  /** Drives the colour: amber under 24 h, red under 1 h (plan 16 §5). */
  severity: CountdownSeverity;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const pad = (n: number) => String(n).padStart(2, '0');

function build(remainingMs: number): Countdown {
  const clamped = Math.max(0, remainingMs);
  const totalSeconds = Math.floor(clamped / 1000);

  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const clock = `${pad(days > 0 ? hours : Math.floor(totalSeconds / 3600))}:${pad(minutes)}:${pad(seconds)}`;

  return {
    remainingMs: clamped,
    days,
    hours,
    minutes,
    seconds,
    label: clamped === 0 ? 'Closed' : days > 0 ? `${days}d ${clock}` : clock,
    expired: clamped === 0,
    severity:
      clamped === 0 ? 'expired' : clamped < HOUR ? 'critical' : clamped < DAY ? 'warning' : 'normal',
  };
}

/**
 * Live countdown to a deadline. Used on the tender and quotation screens, where
 * "closes in 00:47:12" is the difference between a vendor bidding and a vendor
 * missing the window.
 *
 * The interval stops itself once the deadline passes, so a closed tender list
 * does not keep a timer per row running.
 */
export function useCountdown(deadline: Date | string | null | undefined): Countdown {
  const target = deadline ? new Date(deadline).getTime() : null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (target === null || Number.isNaN(target)) return;
    if (target <= Date.now()) {
      setNow(Date.now());
      return;
    }

    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= target) clearInterval(timer);
    }, 1000);

    return () => clearInterval(timer);
  }, [target]);

  if (target === null || Number.isNaN(target)) {
    return { ...build(0), label: '—', severity: 'normal', expired: false };
  }

  return build(target - now);
}

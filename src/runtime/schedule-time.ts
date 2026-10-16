import { z } from "zod";

/**
 * When a scheduled task is due. Three simple shapes instead of cron: every N minutes, every day at a time,
 * or on chosen weekdays at a time. Times are wall-clock times in the schedule's own time zone, so "08:30"
 * stays 08:30 across daylight-saving changes.
 */
export const MIN_INTERVAL_MINUTES = 15;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const ScheduleSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("interval"), everyMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(7 * 24 * 60) }).strict(),
  z.object({ type: z.literal("daily"), time: z.string().regex(TIME) }).strict(),
  // 0 = Sunday ... 6 = Saturday (as in JavaScript's Date#getDay)
  z.object({ type: z.literal("weekly"), days: z.array(z.number().int().min(0).max(6)).min(1).max(7), time: z.string().regex(TIME) }).strict(),
]);
export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface Parts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall-clock reading of an instant in a time zone. */
export function localParts(instant: Date, timeZone: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
  const get = (type: string) => f.formatToParts(instant).find((p) => p.type === type)!.value;
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")), minute: Number(get("minute")), weekday: WEEKDAYS[get("weekday")]! };
}

/**
 * The instant at which a time zone's clock reads the given date and time. Probes the zone's offset twice so
 * it is right on either side of a daylight-saving change; a time that does not exist (the spring-forward gap)
 * lands just after the gap.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = wanted - shown;
    if (diff === 0) return new Date(guess);
    guess += diff;
  }
  return new Date(guess);
}

function atTime(time: string): { hour: number; minute: number } {
  const m = TIME.exec(time)!;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * The first moment strictly after `after` that matches the schedule. For an interval, `anchor` (the time of the
 * previous run, or the schedule's creation) fixes the rhythm so it does not drift with how late each run starts.
 */
export function nextOccurrence(spec: ScheduleSpec, after: Date, timeZone: string, anchor: Date = after): Date {
  if (spec.type === "interval") {
    const step = spec.everyMinutes * 60_000;
    const k = Math.floor((after.getTime() - anchor.getTime()) / step) + 1;
    return new Date(anchor.getTime() + Math.max(1, k) * step);
  }
  const { hour, minute } = atTime(spec.time);
  const allowed = spec.type === "weekly" ? new Set(spec.days) : null;
  const today = localParts(after, timeZone);
  // Walk calendar days in the zone (Date.UTC arithmetic on y/m/d normalizes month ends) for up to 8 days.
  for (let offset = 0; offset <= 8; offset++) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const da = d.getUTCDate();
    if (allowed && !allowed.has(d.getUTCDay())) continue;
    const candidate = zonedTimeToUtc(y, mo, da, hour, minute, timeZone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error("no next occurrence found"); // unreachable for a valid spec
}

/** "Every day at 08:30", for lists. Plain data in, plain words out (the dashboard translates its own). */
export function describeSpec(spec: ScheduleSpec): string {
  if (spec.type === "interval") return `every ${spec.everyMinutes} min`;
  if (spec.type === "daily") return `daily ${spec.time}`;
  return `weekly ${[...spec.days].sort().join(",")} ${spec.time}`;
}

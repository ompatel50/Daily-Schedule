import { SCHEDULE_CATEGORIES, PRIORITIES, type Priority, type ScheduleCategory } from "@/lib/enums";
import { type DayKey, parseTimeToMinute, shiftDay, today, weekdayOf } from "@/lib/date";

/**
 * Natural-language quick add. Typing
 *   "Gym 6:30-7:30pm #fitness !high tomorrow"
 * should create the right item without opening a dialog. Anything it can't
 * parse simply stays in the title, so it never silently loses input.
 */
export interface ParsedQuickAdd {
  title: string;
  date: DayKey;
  startMinute: number | null;
  endMinute: number | null;
  allDay: boolean;
  category: ScheduleCategory;
  priority: Priority;
  tags: string[];
}

const WEEKDAY_NAMES: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const CATEGORY_ALIASES: Record<string, ScheduleCategory> = {
  gym: "fitness",
  workout: "fitness",
  training: "fitness",
  run: "fitness",
  lift: "fitness",
  breakfast: "meal",
  lunch: "meal",
  dinner: "meal",
  snack: "meal",
  meeting: "work",
  standup: "work",
  call: "work",
  study: "learning",
  read: "learning",
  reading: "learning",
  doctor: "health",
  dentist: "health",
  meds: "health",
  nap: "rest",
  sleep: "rest",
};

/** "6:30pm", "6pm", "18:30", "6.30pm" → minutes from midnight. */
function parseClock(raw: string): number | null {
  const cleaned = raw.trim().toLowerCase().replace(/\./g, ":");
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(cleaned);
  if (!match) return null;

  let hours = Number(match[1]);
  const mins = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3];

  if (mins > 59) return null;
  if (meridiem) {
    if (hours > 12 || hours < 1) return null;
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  } else if (hours > 23) {
    return null;
  }

  return hours * 60 + mins;
}

export function parseQuickAdd(input: string, baseDate: DayKey = today()): ParsedQuickAdd {
  let text = ` ${input.trim()} `;
  let date = baseDate;
  let startMinute: number | null = null;
  let endMinute: number | null = null;
  let category: ScheduleCategory | null = null;
  let priority: Priority = "medium";
  const tags: string[] = [];

  // A string strips its first literal occurrence; a RegExp strips by pattern.
  const strip = (pattern: RegExp | string) => {
    text = text.replace(pattern, " ");
  };

  // --- priority: !high / !urgent ------------------------------------------
  const priorityMatch = /\s!(low|medium|high|urgent)\b/i.exec(text);
  if (priorityMatch) {
    priority = priorityMatch[1].toLowerCase() as Priority;
    strip(priorityMatch[0]);
  }

  // --- tags: #tag ----------------------------------------------------------
  for (const match of text.matchAll(/\s#([\w-]+)/g)) {
    const value = match[1].toLowerCase();
    if ((SCHEDULE_CATEGORIES as readonly string[]).includes(value)) {
      category = value as ScheduleCategory;
    } else {
      tags.push(value);
    }
  }
  strip(/\s#[\w-]+/g);

  // --- explicit dates ------------------------------------------------------
  if (/\btomorrow\b/i.test(text)) {
    date = shiftDay(baseDate, 1);
    strip(/\btomorrow\b/i);
  } else if (/\byesterday\b/i.test(text)) {
    date = shiftDay(baseDate, -1);
    strip(/\byesterday\b/i);
  } else if (/\btoday\b/i.test(text)) {
    strip(/\btoday\b/i);
  } else {
    const weekdayMatch = /\b(next\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thu|friday|fri|saturday|sat)\b/i.exec(
      text,
    );
    if (weekdayMatch) {
      const target = WEEKDAY_NAMES[weekdayMatch[2].toLowerCase()];
      const current = weekdayOf(baseDate);
      let delta = (target - current + 7) % 7;
      if (delta === 0) delta = 7; // "monday" on a Monday means next Monday
      if (weekdayMatch[1]) delta += delta <= 7 ? 0 : 7;
      date = shiftDay(baseDate, delta);
      strip(weekdayMatch[0]);
    } else {
      const isoMatch = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
      if (isoMatch) {
        date = isoMatch[1];
        strip(isoMatch[0]);
      }
    }
  }

  // --- time range: "6:30-7:30pm", "at 9am", "9am to 10am" -------------------
  const rangeMatch =
    /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to|until)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.exec(
      text,
    );
  if (rangeMatch) {
    const rawStart = rangeMatch[1];
    const rawEnd = rangeMatch[2];
    let start = parseClock(rawStart);
    const end = parseClock(rawEnd);
    // "6:30-7:30pm" — the meridiem on the end applies to the start too.
    if (start !== null && end !== null && !/(am|pm)/i.test(rawStart) && /pm/i.test(rawEnd) && start < 720) {
      start += 720;
    }
    if (start !== null) {
      startMinute = start;
      endMinute = end !== null && end >= start ? end : null;
      strip(rangeMatch[0]);
    }
  } else {
    const atMatch = /\b(?:at\s+)?(\d{1,2}(?::\d{2})\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\b/i.exec(text);
    if (atMatch) {
      const parsed = parseClock(atMatch[1]);
      if (parsed !== null) {
        startMinute = parsed;
        strip(atMatch[0]);
      }
    }
  }

  strip(/\b(at|on|from)\b\s*$/i);

  // --- category from keywords ---------------------------------------------
  const title = text.replace(/\s+/g, " ").trim().replace(/^[-–—:,]+|[-–—:,]+$/g, "").trim();

  if (!category) {
    const words = title.toLowerCase().split(/\W+/);
    for (const word of words) {
      if (CATEGORY_ALIASES[word]) {
        category = CATEGORY_ALIASES[word];
        break;
      }
      if ((SCHEDULE_CATEGORIES as readonly string[]).includes(word)) {
        category = word as ScheduleCategory;
        break;
      }
    }
  }

  return {
    title: title || input.trim(),
    date,
    startMinute,
    endMinute,
    allDay: startMinute === null,
    category: category ?? "personal",
    priority: (PRIORITIES as readonly string[]).includes(priority) ? priority : "medium",
    tags,
  };
}

/** Preview string shown under the quick-add input as you type. */
export function describeQuickAdd(parsed: ParsedQuickAdd): string {
  const bits: string[] = [];
  bits.push(parsed.allDay ? "All day" : formatPreviewTime(parsed.startMinute, parsed.endMinute));
  bits.push(parsed.date);
  bits.push(parsed.category);
  if (parsed.priority !== "medium") bits.push(parsed.priority);
  if (parsed.tags.length) bits.push(parsed.tags.map((t) => `#${t}`).join(" "));
  return bits.join(" · ");
}

function formatPreviewTime(start: number | null, end: number | null): string {
  if (start === null) return "All day";
  const fmt = (m: number) => {
    const h = Math.floor(m / 60);
    const min = m % 60;
    const suffix = h >= 12 ? "pm" : "am";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${min ? `:${String(min).padStart(2, "0")}` : ""}${suffix}`;
  };
  return end === null ? fmt(start) : `${fmt(start)}–${fmt(end)}`;
}

export { parseTimeToMinute };

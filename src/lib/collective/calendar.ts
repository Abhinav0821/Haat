/** Collective dates use India's calendar (UTC+5:30, without daylight saving). */
export const LOCAL_OFFSET_MS = 330 * 60_000;

export const calendarDate = (instant: Date) => new Date(instant.getTime() + LOCAL_OFFSET_MS).toISOString().slice(0, 10);

/** The instant a collective calendar date begins (midnight IST). */
export const dayBegins = (date: string) => Date.parse(`${date}T00:00:00Z`) - LOCAL_OFFSET_MS;

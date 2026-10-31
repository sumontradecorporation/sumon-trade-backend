/** Wall-clock helpers in a company's time zone (the API server may run in UTC). */
export const DEFAULT_TIME_ZONE = 'Asia/Dhaka';
export function isTimeZone(tz) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    }
    catch {
        return false;
    }
}
/** Calendar day (YYYY-MM-DD), month (YYYY-MM) and time (HH:mm) of `at` in `timeZone`. */
export function zonedNow(timeZone = DEFAULT_TIME_ZONE, at = new Date()) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    });
    const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, month: `${p.year}-${p.month}`, time: `${p.hour}:${p.minute}` };
}
//# sourceMappingURL=time.js.map
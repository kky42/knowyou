/** Format an instant as local wall-clock time: `YYYY-MM-DD HH:mm:ss`. */
export function formatLocalTimestamp(date: Date): string {
	const pad = (value: number, width = 2) => String(value).padStart(width, "0");
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
	);
}

/** User-facing local date/time, optionally without seconds. */
export function formatLocalDateTime(date: Date, seconds = true): string {
	const timestamp = formatLocalTimestamp(date);
	return seconds ? timestamp : timestamp.slice(0, 16);
}

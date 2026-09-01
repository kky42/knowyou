import { describe, expect, it } from "vitest";
import { formatLocalDateTime, formatLocalTimestamp } from "../src/time.js";

describe("local timestamps", () => {
	it("formats the instant with local date/time fields and offset", () => {
		const date = new Date("2026-01-02T03:04:05.678Z");
		const pad = (value: number) => String(value).padStart(2, "0");
		const expected =
			`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
			` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

		expect(formatLocalTimestamp(date)).toBe(expected);
		expect(formatLocalDateTime(date)).toBe(expected);
		expect(formatLocalDateTime(date, false)).toBe(expected.slice(0, 16));
	});
});

import { describe, expect, it } from "vitest";
import { buildPlist, cronSchedule, LABEL } from "../src/schedule.js";

describe("launchd plist", () => {
	it("embeds label, interval, program args and log paths", () => {
		const plist = buildPlist({
			nodePath: "/usr/local/bin/node",
			scriptPath: "/opt/knowyou/dist/cli.js",
			intervalSeconds: 1800,
			logPath: "/Users/x/.knowyou/launchd.log",
		});
		expect(plist).toContain(`<string>${LABEL}</string>`);
		expect(plist).toContain("<integer>1800</integer>");
		expect(plist).toContain("<string>/usr/local/bin/node</string>");
		expect(plist).toContain("<string>/opt/knowyou/dist/cli.js</string>");
		expect(plist).toContain("<string>run</string>");
		expect(plist).toContain("<string>/Users/x/.knowyou/launchd.log</string>");
	});
});

describe("Linux cron schedule", () => {
	it("uses the hour field for intervals above 59 minutes", () => {
		expect(cronSchedule(7200)).toBe("0 */2 * * *");
	});

	it("rejects intervals cron cannot represent exactly", () => {
		expect(() => cronSchedule(5400)).toThrow(/cannot represent/);
	});
});

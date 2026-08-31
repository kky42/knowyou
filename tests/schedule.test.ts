import { describe, expect, it } from "vitest";
import { buildPlist, LABEL } from "../src/schedule.js";

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

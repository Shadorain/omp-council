import { describe, expect, test } from "bun:test";
import { arenaArgumentCompletions, councilArgumentCompletions } from "../src/completions.ts";

describe("councilArgumentCompletions", () => {
	test("lists optional question placeholder before flags and a single help", () => {
		const items = councilArgumentCompletions("");
		expect(items[0]).toMatchObject({
			value: "",
			label: "[question]",
		});
		expect(items[0]?.hint).toBeTruthy();
		expect(items.filter((item) => /help/i.test(item.value) || /help/i.test(item.label)).map((item) => item.value)).toEqual([
			"help",
		]);
		expect(items.some((item) => item.value === "--help" || item.value === "-h")).toBe(false);
		const flags = items.filter((item) => item.value.startsWith("-"));
		expect(flags.map((item) => item.value)).toEqual(["-t", "--quick", "--debate", "--deep", "--role"]);
		for (const item of items) {
			expect(item.description.length).toBeGreaterThan(0);
			expect(item.description).not.toContain(item.value || item.label);
		}
		for (const item of flags) {
			expect(item.label).toBe(item.value);
			expect(item.hint).toContain("[question]");
		}
	});

	test("selecting a completion inserts the flag, not the description", () => {
		const deep = councilArgumentCompletions("--d").find((item) => item.value === "--deep");
		expect(deep).toBeDefined();
		expect(deep?.value).toBe("--deep");
		expect(deep?.label).toBe("--deep");
		expect(deep?.description).toBeTruthy();
		expect(deep?.description.includes("--deep")).toBe(false);
	});

	test("filters by flag prefix and hides the placeholder", () => {
		expect(councilArgumentCompletions("--d").map((item) => item.value)).toEqual(["--debate", "--deep"]);
	});

	test("collapses -t and --tmp onto the matching insert value", () => {
		const tmp = councilArgumentCompletions("--tm");
		expect(tmp.map((item) => item.value)).toEqual(["--tmp"]);
		expect(tmp[0]?.label).toBe("--tmp");
		expect(councilArgumentCompletions("-t").map((item) => item.value)).toEqual(["-t"]);
	});

	test("keeps already-typed flags when completing the next token", () => {
		const items = councilArgumentCompletions("-t --de");
		expect(items.map((item) => item.value)).toEqual(["-t --debate", "-t --deep"]);
		expect(items.every((item) => item.label === "--deep" || item.label === "--debate")).toBe(true);
	});

	test("after --role, completes role presets with insertable values", () => {
		const items = councilArgumentCompletions("--role a");
		expect(items.map((item) => item.value)).toEqual(["--role architecture"]);
		expect(items[0]?.label).toBe("architecture");
		expect(items[0]?.description).toBeTruthy();
	});

	test("bare -- ends completions so the question is free text", () => {
		expect(councilArgumentCompletions("-t --deep -- ")).toEqual([]);
		expect(councilArgumentCompletions("-- Review this")).toEqual([]);
	});

	test("lifecycle commands are one token and have descriptions", () => {
		const items = councilArgumentCompletions("can");
		expect(items.map((item) => item.value)).toEqual(["cancel"]);
		expect(items[0]?.description.toLowerCase()).toContain("abort");
	});

	test("a completed lifecycle command has no further suggestions", () => {
		expect(councilArgumentCompletions("cancel ")).toEqual([]);
		expect(councilArgumentCompletions("status extra")).toEqual([]);
	});
});

describe("arenaArgumentCompletions", () => {
	test("lists optional task placeholder, flags, apply, and a single help", () => {
		const items = arenaArgumentCompletions("");
		expect(items[0]).toMatchObject({ value: "", label: "[task]" });
		expect(items.map((item) => item.value)).toContain("apply");
		expect(items.filter((item) => item.value === "help" || item.value === "--help" || item.value === "-h")).toEqual([
			expect.objectContaining({ value: "help" }),
		]);
		expect(items.some((item) => item.value === "--profile")).toBe(true);
		expect(items.some((item) => item.value === "--judge")).toBe(true);
		expect(items.find((item) => item.value === "--profile")?.hint).toContain("<profile>");
	});

	test("after --profile, completes rust/general/auto", () => {
		expect(arenaArgumentCompletions("--profile r").map((item) => item.value)).toEqual(["--profile rust"]);
	});

	test("apply is hidden once flags are in play", () => {
		expect(arenaArgumentCompletions("-t ").some((item) => item.value.endsWith("apply"))).toBe(false);
	});
});

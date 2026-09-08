import { describe, expect, test } from "bun:test";
import { optionsMatchingQuery, paint } from "../src/picker.ts";

describe("optionsMatchingQuery", () => {
	const options = [
		{ label: "Claude Sonnet 5  [anthropic/claude-sonnet-5]", description: "anthropic • claude-sonnet-5" },
		{ label: "Grok 4.6  [xai-oauth/grok-4.6]", description: "xai-oauth • grok-4.6" },
		{ label: "Gemini 3.1 Pro  [google-antigravity/gemini-3.1-pro]", description: "google-antigravity • gemini-3.1-pro" },
	];

	test("returns all options for an empty query", () => {
		expect(optionsMatchingQuery(options, "")).toEqual(options);
	});

	test("filters by label or provider text", () => {
		expect(optionsMatchingQuery(options, "grok").map((item) => item.label)).toEqual([
			"Grok 4.6  [xai-oauth/grok-4.6]",
		]);
		expect(optionsMatchingQuery(options, "anthropic").map((item) => item.label)).toEqual([
			"Claude Sonnet 5  [anthropic/claude-sonnet-5]",
		]);
	});

	test("matches space-separated tokens across label and description", () => {
		expect(optionsMatchingQuery(options, "gemini pro").map((item) => item.label)).toEqual([
			"Gemini 3.1 Pro  [google-antigravity/gemini-3.1-pro]",
		]);
	});

	test("paint calls theme.fg as a method so private fields stay bound", () => {
		class ThemeStub {
			#e: Record<string, string> = { accent: "X" };
			fg(color: string, text: string) {
				const prefix = this.#e[color];
				if (!prefix) throw new Error("missing color");
				return `${prefix}${text}`;
			}
		}
		expect(paint(new ThemeStub() as never, "accent", "Hi")).toBe("XHi");
	});
});

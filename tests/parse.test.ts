import { describe, expect, test } from "bun:test";
import { parseArenaSyntax, parseCouncilSyntax, parseHistoryArgs, splitOptionalPayload } from "../src/parse.ts";

describe("splitOptionalPayload", () => {
	test("keeps flags when no -- delimiter", () => {
		expect(splitOptionalPayload("-t --deep --role architecture")).toEqual({
			left: "-t --deep --role architecture",
		});
	});

	test("splits on bare --", () => {
		expect(splitOptionalPayload("-t --deep --role architecture -- Review this.")).toEqual({
			left: "-t --deep --role architecture",
			question: "Review this.",
		});
	});

	test("rejects empty prompt after --", () => {
		expect(() => splitOptionalPayload("--deep --")).toThrow("Prompt cannot be empty");
	});
});

describe("parseCouncilSyntax", () => {
	test("parses -t and --tmp", () => {
		expect(parseCouncilSyntax("-t -- Review this.").temporary).toBe(true);
		expect(parseCouncilSyntax("--tmp -- Review this.").temporary).toBe(true);
		expect(parseCouncilSyntax("default -- Review this.").temporary).toBe(false);
	});

	test("defaults to debate/general", () => {
		const parsed = parseCouncilSyntax("default -- Should we extract a repository?");
		expect(parsed.mode).toBe("debate");
		expect(parsed.rolePreset).toBe("general");
		expect(parsed.participantTokens).toEqual(["default"]);
		expect(parsed.question).toBe("Should we extract a repository?");
	});

	test("parses --deep --role architecture", () => {
		const parsed = parseCouncilSyntax("-t --deep --role architecture -- Review this.");
		expect(parsed).toMatchObject({
			temporary: true,
			mode: "deep",
			modeSpecified: true,
			rolePreset: "architecture",
			roleSpecified: true,
			question: "Review this.",
		});
	});

	test("lowercases --role=Architecture", () => {
		const parsed = parseCouncilSyntax("--role=Architecture -- Review this.");
		expect(parsed.rolePreset).toBe("architecture");
		expect(parsed.roleSpecified).toBe(true);
	});

	test("rejects unknown role", () => {
		expect(() => parseCouncilSyntax("--role banana -- x")).toThrow("Unknown role preset");
	});
});

describe("parseArenaSyntax", () => {
	test("parses -t --profile rust", () => {
		const parsed = parseArenaSyntax("-t --profile rust -- Refactor this persistence layer.");
		expect(parsed).toMatchObject({
			temporary: true,
			arenaProfile: "rust",
			profileSpecified: true,
			question: "Refactor this persistence layer.",
		});
	});

	test("parses --judge and --judge=", () => {
		expect(parseArenaSyntax("--judge @slow -- task").judgeToken).toBe("@slow");
		expect(parseArenaSyntax("--judge=provider/model -- task").judgeToken).toBe("provider/model");
	});

	test("lowercases --profile=Rust", () => {
		expect(parseArenaSyntax("--profile=Rust -- task").arenaProfile).toBe("rust");
	});
});

describe("parseHistoryArgs", () => {
	test("reads the run id", () => {
		expect(parseHistoryArgs("history")).toEqual({ id: undefined });
		expect(parseHistoryArgs("history C14")).toEqual({ id: "C14" });
		expect(parseHistoryArgs("history c1 extra")).toEqual({ id: "c1" });
	});
});

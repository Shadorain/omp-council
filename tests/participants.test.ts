import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig } from "../src/config.ts";
import { resolveParticipantTokens, splitBarePrompt } from "../src/participants.ts";
import type { CouncilConfig } from "../src/types.ts";

afterEach(() => {
	delete process.env.OMP_COUNCIL_CONFIG;
	delete process.env.OMP_AGENT_DIR;
});

function mockCtx(models: string[]) {
	const resolved = new Map(models.map((selector) => {
		const [provider, id] = selector.split("/");
		return [selector, { provider, id, name: id }];
	}));
	return {
		models: {
			resolve(spec: string) {
				return resolved.get(spec) ?? [...resolved.values()].find((model) => model.id === spec);
			},
			list() {
				return [...resolved.values()];
			},
			current() {
				return [...resolved.values()][0];
			},
		},
	} as never;
}

describe("resolveParticipantTokens", () => {
	test("expands presets, tags, and one-shot selectors without writing config", async () => {
		const dir = await mkdtemp(join(tmpdir(), "council-cfg-"));
		const path = join(dir, "council.json");
		process.env.OMP_COUNCIL_CONFIG = path;
		const config: CouncilConfig = {
			version: 1,
			participants: [
				{ id: "alpha", label: "Alpha", model: "prov/a", aliases: ["reasoner"], tags: ["reasoning"] },
				{ id: "beta", label: "Beta", model: "prov/b", aliases: ["local"], tags: ["local"] },
			],
			presets: { default: ["alpha", "beta"] },
		};
		writeConfig(config);
		const before = readFileSync(path, "utf8");
		const ctx = mockCtx(["prov/a", "prov/b", "prov/c"]);
		const tagged = resolveParticipantTokens(ctx, config, ["tag:reasoning", "prov/c"]);
		expect(tagged.map((p) => p.model)).toEqual(["prov/a", "prov/c"]);
		expect(tagged[1].temporary).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("one-shot model selectors do not require a registry", () => {
		const ctx = mockCtx(["prov/a", "prov/b"]);
		const selected = resolveParticipantTokens(ctx, undefined, ["prov/a", "prov/b"]);
		expect(selected.every((p) => p.temporary)).toBe(true);
		expect(existsSync(join(tmpdir(), "no-such-council.json"))).toBe(false);
	});
});

describe("splitBarePrompt", () => {
	const config: CouncilConfig = {
		version: 1,
		participants: [
			{ id: "alpha", label: "Alpha", model: "prov/a", aliases: ["reasoner"], tags: ["reasoning"] },
			{ id: "beta", label: "Beta", model: "prov/b", aliases: ["local"], tags: ["local"] },
		],
		presets: { default: ["alpha", "beta"] },
	};

	test("treats an unresolved token as the prompt, not a missing model", () => {
		const ctx = mockCtx(["prov/a", "prov/b"]);
		expect(splitBarePrompt(ctx, config, ["test"])).toEqual({
			participantTokens: [],
			question: "test",
		});
	});

	test("keeps resolved selectors and treats the rest as the prompt", () => {
		const ctx = mockCtx(["prov/a", "prov/b"]);
		expect(splitBarePrompt(ctx, config, ["default", "review", "this"])).toEqual({
			participantTokens: ["default"],
			question: "review this",
		});
	});

	test("leaves fully resolved selectors without a prompt", () => {
		const ctx = mockCtx(["prov/a", "prov/b"]);
		expect(splitBarePrompt(ctx, config, ["alpha", "beta"])).toEqual({
			participantTokens: ["alpha", "beta"],
		});
	});
});

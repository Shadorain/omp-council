import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyChairSystemPrompt,
	arenaEvalCode,
	chairInstruction,
	chairTurnContent,
	councilEvalCode,
	evalInputFor,
	findFinalJson,
	isChairPlumbing,
	isKickoffPrompt,
	isSmokeQuestion,
	kickoffDetails,
	userFacingKickoff,
} from "../src/orchestration.ts";

import { cleanupRuntimeAgents, runtimeAgentName } from "../src/runtime-agents.ts";
import type { ActiveRun } from "../src/types.ts";

afterEach(() => {
	delete process.env.OMP_AGENT_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
});


function councilRun(mode: ActiveRun["mode"] = "debate"): ActiveRun {
	return {
		id: "C4",
		seq: 4,
		kind: "council",
		sessionKey: "s1",
		question: "Review this architecture.",
		participants: [
			{
				label: "Model A",
				model: "prov-a/m-a",
				provider: "prov-a",
				temporary: true,
				key: "seat1",
				agent: runtimeAgentName("s1", "C4", "seat1", 1),
				lens: "systems architect",
			},
			{
				label: "Model B",
				model: "prov-b/m-b",
				provider: "prov-b",
				temporary: true,
				key: "seat2",
				agent: runtimeAgentName("s1", "C4", "seat2", 1),
				lens: "simplifier",
			},
		],
		temporary: true,
		phase: "queued",
		startedAt: 0,
		awaitingEval: true,
		cancelRequested: false,
		mode,
		rolePreset: "architecture",
		runtimeAgentPaths: [],
		members: {},
	};
}

function arenaRun(): ActiveRun {
	return {
		...councilRun(),
		id: "A8",
		kind: "arena",
		arenaProfile: "rust",
		judgeAgent: runtimeAgentName("s1", "A8", "judge", 1),
		judgeModel: "prov-c/judge",
		mode: undefined,
		rolePreset: "general",
	};
}

describe("councilEvalCode", () => {
	test("spawns independent agents then reuses handles for rebuttal", () => {
		const code = councilEvalCode(councilRun("debate"));
		expect(code).toContain("agent(prompt,");
		expect(code).toContain("handles[i].send(");
		expect(code).toContain("schemaMode: \"strict\"");
		expect(code).toContain("changedPosition");
		expect(code).toContain("await release(handles)");
		expect(code).toContain("handle.cancel()");
		expect(code).not.toContain("majority");
		expect(code).not.toContain("claude");
		expect(code).not.toContain("codex");
		expect(code).not.toContain("grok");
	});

	test("quick mode skips rebuttal send", () => {
		const code = councilEvalCode(councilRun("quick"));
		expect(code).toContain('run.mode !== "quick"');
		expect(code).toContain("handles[i].send(");
	});
});

describe("arenaEvalCode", () => {
	test("isolates candidates and hides identities from the judge", () => {
		const code = arenaEvalCode(arenaRun());
		expect(code).toContain("isolated: true");
		expect(code).toContain("apply: false");
		expect(code).toContain("merge: false");
		expect(code).toContain("cargo fmt --check");
		expect(code).toContain("cargo clippy --workspace --all-targets");
		expect(code).toContain("anonymized");
		expect(code).toContain("Candidate ");
		expect(code).toContain("handle.cancel()");
		expect(code).toContain("await release([...handles, judgeHandle])");
	});
});

describe("evalInputFor", () => {
	test("shows a short stub, not the orchestration source", async () => {
		const dir = await mkdtemp(join(tmpdir(), "council-eval-"));
		process.env.OMP_AGENT_DIR = dir;
		mkdirSync(join(dir, "agents"), { recursive: true });
		const run = councilRun();
		const input = evalInputFor(run);
		expect(input.language).toBe("js");
		expect(input.timeout).toBe(0);
		expect(input.title).toBe("Council C4 · Model A, Model B");
		const code = String(input.code);
		expect(code.split("\n").length).toBe(1);
		expect(code).not.toContain("Adversarial review");
		expect(code).toContain("Bun.file");
		const scriptPath = run.runtimeAgentPaths[0];
		expect(scriptPath).toBeDefined();
		expect(existsSync(scriptPath ?? "")).toBe(true);
		const script = readFileSync(scriptPath ?? "", "utf8");
		expect(script.startsWith("(async () =>")).toBe(true);
		expect(script).toContain("handles[i].send(");
		expect(script).toContain("Bun.write");
		expect(script).not.toContain("display(result)");



		cleanupRuntimeAgents(run);
		expect(existsSync(scriptPath ?? "")).toBe(false);
	});
});

describe("chair kickoff", () => {
	test("chair turn is labeled Council work, not a raw user chat line", () => {
		const run = councilRun();
		const text = chairTurnContent(run);
		expect(text).toBe("Council C4 · tmp · debate · architecture\n\nCall eval once. Do not search the repo.");
		expect(text).not.toContain("Review this architecture.");
		expect(text).not.toContain("not a normal chat turn");
		expect(userFacingKickoff(run)).toBe(text);
		expect(isKickoffPrompt(text)).toBe(false);
		expect(kickoffDetails(run)).toEqual({
			id: "C4",
			kind: "council",
			mode: "debate",
			rolePreset: "architecture",
			arenaProfile: undefined,
			temporary: true,
			question: "Review this architecture.",
			seats: ["Model A", "Model B"],
			judge: undefined,
		});
	});

	test("eval instructions append to the system prompt, not the user message", () => {
		const run = councilRun();
		expect(chairInstruction(run)).toContain("eval");
		expect(chairInstruction(run)).toContain("Review this architecture.");
		expect(applyChairSystemPrompt(["base"], run)).toEqual(["base", chairInstruction(run)]);
	});

	test("session-stop nudge is plumbing, not a user prompt", () => {
		expect(
			isChairPlumbing(
				"Council extension C4 is awaiting its deterministic orchestration call. Call eval exactly once now; the extension will replace the input.",
			),
		).toBe(true);
		expect(isChairPlumbing("Review this architecture.")).toBe(false);
	});

	test("short Testing prompt is a harness smoke, not a product review", () => {
		expect(isSmokeQuestion("Testing")).toBe(true);
		expect(isSmokeQuestion("test")).toBe(true);
		expect(isSmokeQuestion("Review this architecture.")).toBe(false);
		const run = councilRun();
		run.question = "Testing";
		expect(chairTurnContent(run)).toContain("Call eval once");
		expect(chairTurnContent(run)).not.toContain("Testing");
		expect(chairInstruction(run)).toContain("harness smoke");
		expect(councilEvalCode(run)).toContain("harness smoke check");
	});
});

describe("findFinalJson", () => {

	test("matches the active run id rather than the next eval blob", () => {
		const details = {
			nested: {
				kind: "council",
				runId: "C4",
				ok: true,
			},
			other: { kind: "council", runId: "C9" },
		};
		expect(findFinalJson(details, "council", "C4")).toEqual(details.nested);
		expect(findFinalJson(details, "council", "C3")).toBeUndefined();
	});
});

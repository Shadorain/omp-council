import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistRunDump, readRunDumps, historyText, applyOrchestrationResult, applyProgress, assignLenses, createRuntimeState, hydrateUsageFromEval, makeRun, snapshotRun } from "../src/state.ts";
import { isTerminalPhase } from "../src/types.ts";
import { formatCost, formatDuration, kickoffCardLines, visWidth, widgetLines, widgetShimmerEnabled } from "../src/widget.ts";

const dirs: string[] = [];

afterEach(() => {
	delete process.env.OMP_AGENT_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
});
describe("makeRun", () => {
	test("pins unique agents per session instance", () => {
		const a = createRuntimeState("session-aaa");
		const b = createRuntimeState("session-bbb");
		const selected = [
			{ label: "A", model: "p/a", provider: "p", temporary: true },
			{ label: "B", model: "p/b", provider: "p", temporary: true },
		];
		const runA = makeRun(a, "council", "q", selected, { temporary: true, mode: "debate", rolePreset: "architecture" });
		const runB = makeRun(b, "council", "q", selected, { temporary: true, mode: "debate", rolePreset: "architecture" });
		expect(runA.participants[0].agent).not.toBe(runB.participants[0].agent);
		expect(runA.temporary).toBe(true);
		expect(runA.participants.every((p) => p.temporary)).toBe(true);
	});

	test("rotates lenses by run sequence, not provider", () => {
		const first = assignLenses(2, "architecture", 1);
		const second = assignLenses(2, "architecture", 2);
		expect(first[0]).not.toBe(second[0]);
	});
});

describe("applyProgress", () => {
	test("records per-stage status for widget columns", () => {
		const state = createRuntimeState("s");
		const run = makeRun(
			state,
			"council",
			"q",
			[
				{ label: "A", model: "p/a", provider: "p", temporary: false },
				{ label: "B", model: "p/b", provider: "p", temporary: false },
			],
			{ temporary: false, mode: "debate", rolePreset: "debug" },
		);
		applyProgress(run, { phase: "independent", member: "seat1", status: "done", message: "complete" });
		applyProgress(run, { phase: "rebuttal", member: "seat1", status: "running", message: "challenging peers" });
		expect(run.members.seat1.stages.independent).toBe("done");
		expect(run.members.seat1.stages.rebuttal).toBe("running");
		const lines = widgetLines(run, 0, { shimmer: false });
		expect(lines[0]).toContain("╭");
		expect(lines[0]).toContain("Council");
		expect(lines[0]).toContain("C1");
		expect(lines.some((line) => line.includes("│") && line.includes("q"))).toBe(true);
		expect(lines.at(-1)).toContain("╰");
		expect(lines.some((line) => line.includes("position") && line.includes("rebuttal"))).toBe(true);
	});

	test("queued seats are labeled, not marked cancelled", () => {
		const state = createRuntimeState("s");
		const run = makeRun(
			state,
			"council",
			"q",
			[
				{ label: "Claude Sonnet 5", model: "p/a", provider: "p", temporary: false },
				{ label: "Grok 4.6", model: "p/b", provider: "p", temporary: false },
			],
			{ temporary: false, mode: "debate", rolePreset: "general" },
		);
		const text = widgetLines(run, 0, { shimmer: false }).join("\n");
		expect(text).toContain("queued");
		expect(text).not.toContain("×");
		expect(text).toContain("/council cancel");
		expect(text).toContain("Esc");
		expect(text).toContain("q");
		expect(text).toContain("starting seats");


	});

	test("live header uses the purple wave unless shimmer is off", () => {
		const state = createRuntimeState("s");
		const run = makeRun(
			state,
			"council",
			"q",
			[
				{ label: "A", model: "p/a", provider: "p", temporary: false },
				{ label: "B", model: "p/b", provider: "p", temporary: false },
			],
			{ temporary: false, mode: "debate", rolePreset: "general" },
		);
		expect(widgetLines(run, 0, { shimmer: true })[0]).toContain("\x1b[38;2;");
		expect(widgetLines(run, 0, { shimmer: false })[0]).not.toContain("\x1b[38;2;");
	});

	test("eval result fills queued seats so the widget is not stuck queued", () => {
		const state = createRuntimeState("s");
		const run = makeRun(
			state,
			"council",
			"q",
			[
				{ label: "Gemini 2.5 Flash", model: "p/a", provider: "p", temporary: true },
				{ label: "Gemini 3.1 Flash Lite", model: "p/b", provider: "p", temporary: true },
			],
			{ temporary: true, mode: "quick", rolePreset: "general" },
		);
		run.phase = "done";
		applyOrchestrationResult(run, {
			kind: "council",
			runId: run.id,
			initial: [
				{ member: "seat1", data: { recommendation: "smoke" } },
				{ member: "seat2", error: "boom" },
			],
		});
		expect(run.members.seat1?.status).toBe("done");
		expect(run.members.seat1?.stages.independent).toBe("done");
		expect(run.members.seat2?.status).toBe("failed");
		const text = widgetLines(run, 0, { shimmer: false }).join("\n");
		expect(text).toContain("done");
		expect(text).toContain("failed");
		expect(text).not.toMatch(/queued position/);
	});

	test("shows seat cost time and fallback model", () => {
		const state = createRuntimeState("s");
		const run = makeRun(
			state,
			"council",
			"q",
			[
				{ label: "Gemini 3.7 Flash", model: "google-antigravity/gemini-3.7-flash", provider: "google-antigravity", temporary: true },
				{ label: "Gemini 3.8 Flash", model: "google-antigravity/gemini-3.8-flash", provider: "google-antigravity", temporary: true },
			],
			{ temporary: true, mode: "quick", rolePreset: "general" },
		);
		applyProgress(run, { phase: "independent", member: "seat1", status: "done", cost: 0.02, durationMs: 8100 });
		hydrateUsageFromEval(run, {
			statusEvents: [
				{
					op: "agent",
					id: `${run.id}-seat2-position`,
					cost: 0.09,
					durationMs: 12400,
					model: "xai-oauth/grok-4.5",
					resolvedModelIsFallback: true,
				},
			],
		});
		run.phase = "done";
		run.finishedAt = run.startedAt + 20000;
		const text = widgetLines(run, run.startedAt + 20000, { shimmer: false }).join("\n");
		expect(text).toContain("$0.02");
		expect(text).toContain("8.1s");
		expect(text).toContain("$0.09");
		expect(text).toContain("via xai-oauth/grok-4.5");
		expect(text).toContain("total");
		expect(text).toContain("$0.11");
		expect(run.members.seat2?.fallback).toBe(true);
	});

	test("hides total while the run is still live", () => {
		const state = createRuntimeState("s");
		const run = makeRun(
			state,
			"council",
			"q",
			[{ label: "A", model: "m-a", provider: "p", temporary: true }],
			{ temporary: true, mode: "quick", rolePreset: "general" },
		);
		applyProgress(run, { phase: "independent", member: "seat1", status: "done", cost: 0.02, durationMs: 8100 });
		run.phase = "independent";
		const live = widgetLines(run, run.startedAt + 20000, { shimmer: false }).join("\n");
		expect(live).not.toMatch(/\btotal\b/);
		run.phase = "done";
		run.finishedAt = run.startedAt + 20000;
		const done = widgetLines(run, run.startedAt + 40000, { shimmer: false }).join("\n");
		expect(done).toContain("total");
		expect(done).toContain("20s");
	});

	test("formatDuration and formatCost match eval-style badges", () => {
		expect(formatDuration(8100)).toBe("8.1s");
		expect(formatCost(0.02)).toBe("$0.02");
		expect(formatCost(0)).toBe("");
	});

	test("kickoff card is an ASCII Council banner for the chat", () => {
		const lines = kickoffCardLines({
			id: "C10",
			kind: "council",
			mode: "debate",
			rolePreset: "general",
			temporary: true,
			question: "Testing",
			seats: ["Gemini 3.1 Flash Lite", "Gemini 3.1 Flash Lite"],
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Council");
		expect(lines[0]).toContain("C10");
		expect(lines[0]).toMatch(/─/);
		expect(lines[0]).not.toContain("Testing");
		expect(lines[0]).not.toContain("Gemini");
		expect(visWidth(lines[0])).toBe(72);
	});
});

describe("widgetShimmerEnabled", () => {
	const previousShimmer = process.env.OMP_COUNCIL_SHIMMER;
	const previousConfig = process.env.OMP_COUNCIL_CONFIG;
	afterEach(() => {
		if (previousShimmer === undefined) delete process.env.OMP_COUNCIL_SHIMMER;
		else process.env.OMP_COUNCIL_SHIMMER = previousShimmer;
		if (previousConfig === undefined) delete process.env.OMP_COUNCIL_CONFIG;
		else process.env.OMP_COUNCIL_CONFIG = previousConfig;
	});

	test("env 0 disables the wave", () => {
		process.env.OMP_COUNCIL_SHIMMER = "0";
		expect(widgetShimmerEnabled()).toBe(false);
	});

	test("defaults on", () => {
		delete process.env.OMP_COUNCIL_SHIMMER;
		process.env.OMP_COUNCIL_CONFIG = "/tmp/omp-council-no-such-config.json";
		expect(widgetShimmerEnabled()).toBe(true);
	});
});
describe("clear/cancel gates", () => {
	test("live phases are not terminal", () => {
		expect(isTerminalPhase("independent")).toBe(false);
		expect(isTerminalPhase("cancelling")).toBe(false);
		expect(isTerminalPhase("done")).toBe(true);
		expect(isTerminalPhase("cancelled")).toBe(true);
	});

	test("snapshot keeps temporary flag for history", () => {
		const state = createRuntimeState("s");
		const run = makeRun(
			state,
			"arena",
			"implement",
			[
				{ label: "A", model: "p/a", provider: "p", temporary: true },
				{ label: "B", model: "p/b", provider: "p", temporary: true },
			],
			{ temporary: true, arenaProfile: "rust", judgeModel: "p/j" },
		);
		expect(snapshotRun(run).temporary).toBe(true);
		expect(run.judgeAgent).toBeTruthy();
	});

	test("persistRunDump keeps a capped jsonl ring", async () => {
		const dir = await mkdtemp(join(tmpdir(), "council-runs-"));
		dirs.push(dir);
		process.env.OMP_AGENT_DIR = dir;
		const state = createRuntimeState("s");
		const selected = [
			{ label: "A", model: "p/a", provider: "p", temporary: true },
			{ label: "B", model: "p/b", provider: "p", temporary: true },
		];
		const run = makeRun(state, "council", "Testing", selected, { temporary: true, mode: "quick", rolePreset: "general" });
		run.final = { kind: "council", runId: run.id, initial: [{ member: "seat1", data: { recommendation: "ok" } }] };
		run.phase = "done";
		const path = persistRunDump(run);
		expect(path).toBe(join(dir, "council-runs.jsonl"));
		expect(existsSync(join(dir, "council-runs"))).toBe(false);
		const dumped = JSON.parse(readFileSync(path!, "utf8").trim());
		expect(dumped.question).toBe("Testing");
		expect(dumped.final.initial[0].data.recommendation).toBe("ok");
		expect(historyText(run.id)).toContain("Testing");
		for (let i = 0; i < 21; i++) {
			const extra = makeRun(state, "council", `q${i}`, selected, { temporary: true, mode: "quick", rolePreset: "general" });
			extra.phase = "done";
			persistRunDump(extra);
		}
		expect(readRunDumps()).toHaveLength(20);
		expect(historyText()).toContain("cap 20");
	});
});

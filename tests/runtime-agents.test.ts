import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupRuntimeAgents,
	cleanupRuntimeAgentsByPrefix,
	cleanupSeatTranscripts,
	isOwnChildSession,
	isRuntimeAgentName,
	materializeRuntimeAgents,
	runtimeAgentName,
} from "../src/runtime-agents.ts";
import type { ActiveRun } from "../src/types.ts";

const dirs: string[] = [];

afterEach(() => {
	delete process.env.OMP_AGENT_DIR;
	delete process.env.OMP_COUNCIL_CONFIG;
	delete process.env.PI_CODING_AGENT_DIR;
});

async function isolatedAgentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "council-agents-"));
	dirs.push(dir);
	process.env.OMP_AGENT_DIR = dir;
	mkdirSync(join(dir, "agents"), { recursive: true });
	return dir;
}

function sampleRun(instanceId: string, extra?: Partial<ActiveRun>): ActiveRun {
	return {
		id: "C1",
		seq: 1,
		kind: "council",
		sessionKey: "sess-a",
		question: "review",
		participants: [
			{
				label: "Model A",
				model: "provider-a/model-a",
				provider: "provider-a",
				temporary: true,
				key: "seat1",
				agent: runtimeAgentName(instanceId, "C1", "seat1", 4242),
				lens: "lens",
			},
			{
				label: "Model B",
				model: "provider-b/model-b",
				provider: "provider-b",
				temporary: true,
				key: "seat2",
				agent: runtimeAgentName(instanceId, "C1", "seat2", 4242),
				lens: "lens",
			},
		],
		temporary: true,
		phase: "queued",
		startedAt: Date.now(),
		awaitingEval: true,
		cancelRequested: false,
		runtimeAgentPaths: [],
		members: {},
		...extra,
	};
}

describe("runtime agents", () => {
	test("names include pid, instance, and run so sessions cannot collide", () => {
		const a = runtimeAgentName("sess-one", "C1", "seat1", 11);
		const b = runtimeAgentName("sess-two", "C1", "seat1", 11);
		const c = runtimeAgentName("sess-one", "C1", "seat1", 12);
		expect(a).not.toBe(b);
		expect(a).not.toBe(c);
		expect(isRuntimeAgentName(a)).toBe(true);
	});

	test("materialize writes model-pinned files and cleanup deletes them", async () => {
		const dir = await isolatedAgentDir();
		const run = sampleRun("sess-a");
		materializeRuntimeAgents(run);
		expect(run.runtimeAgentPaths.length).toBe(2);
		for (const path of run.runtimeAgentPaths) {
			expect(existsSync(path)).toBe(true);
			const body = readFileSync(path, "utf8");
			expect(body).toContain("model:");
			expect(body).not.toContain("claude");
			expect(body).not.toContain("codex");
		}
		const removed = cleanupRuntimeAgents(run);
		expect(removed.length).toBe(2);
		expect(run.runtimeAgentPaths).toEqual([]);
		expect(existsSync(join(dir, "agents", `${run.participants[0].agent}.md`))).toBe(false);
	});

	test("prefix cleanup does not delete another session's files", async () => {
		await isolatedAgentDir();
		const runA = sampleRun("sess-a");
		const runB = sampleRun("sess-b");
		materializeRuntimeAgents(runA);
		materializeRuntimeAgents(runB);
		cleanupRuntimeAgentsByPrefix("sess-a", 4242);
		expect(existsSync(runA.runtimeAgentPaths[0])).toBe(false);
		expect(existsSync(runB.runtimeAgentPaths[0])).toBe(true);
		cleanupRuntimeAgents(runB);
	});

	test("temporary run files never write council.json", async () => {
		const dir = await isolatedAgentDir();
		process.env.OMP_COUNCIL_CONFIG = join(dir, "council.json");
		const run = sampleRun("sess-a");
		materializeRuntimeAgents(run);
		expect(existsSync(join(dir, "council.json"))).toBe(false);
		cleanupRuntimeAgents(run);
	});

	test("detects recursive child sessions", () => {
		expect(isOwnChildSession("omp-council-1-abc-c1-seat1", undefined)).toBe(true);
		expect(isOwnChildSession("C14-seat1-position", undefined)).toBe(true);
		expect(isOwnChildSession("Main", "/tmp/session.jsonl")).toBe(false);
		expect(isOwnChildSession("Main", "/Users/you/omp-council/session.jsonl")).toBe(false);
		expect(isOwnChildSession(undefined, "/Users/you/.omp/agent/sessions/-Users-you-omp-council/2026.jsonl")).toBe(false);
	});

	test("stale leftover file from this instance is removed by prefix cleanup", async () => {
		const dir = await isolatedAgentDir();
		const name = runtimeAgentName("sess-a", "C9", "seat1", 4242);
		const stale = join(dir, "agents", `${name}.md`);
		const script = join(dir, "agents", `${runtimeAgentName("sess-a", "C9", "eval", 4242)}.js`);
		writeFileSync(stale, "stale");
		writeFileSync(script, "return 1;");
		cleanupRuntimeAgentsByPrefix("sess-a", 4242);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(script)).toBe(false);
	});

	test("deletes leftover Hub seat transcripts next to the parent session", async () => {
		const dir = await isolatedAgentDir();
		const parent = join(dir, "parent.jsonl");
		const seat = join(dir, "C9-seat1-position.jsonl");
		const other = join(dir, "C8-seat1-position.jsonl");
		writeFileSync(parent, "parent");
		writeFileSync(seat, "seat");
		writeFileSync(other, "other");
		cleanupSeatTranscripts(parent, "C9");
		expect(existsSync(seat)).toBe(false);
		expect(existsSync(`${seat}.tombstone`)).toBe(true);
		expect(existsSync(other)).toBe(true);
		expect(existsSync(parent)).toBe(true);
	});
});

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { slug } from "./config.ts";
import { runtimeAgentDir } from "./paths.ts";
import { RUNTIME_AGENT_PREFIX, type ActiveRun, type RunKind } from "./types.ts";

const COUNCIL_TOOLS = ["read", "grep", "glob", "bash", "yield"];
const ARENA_TOOLS = ["read", "grep", "glob", "bash", "write", "edit", "yield"];
const JUDGE_TOOLS = ["read", "grep", "glob", "yield"];

export function runtimeAgentName(instanceId: string, runId: string, key: string, pid = process.pid): string {
	return `${RUNTIME_AGENT_PREFIX}-${pid}-${slug(instanceId)}-${runId.toLowerCase()}-${slug(key)}`;
}

export function isRuntimeAgentName(name: string): boolean {
	return name.startsWith(`${RUNTIME_AGENT_PREFIX}-`);
}

export function writeEvalScript(run: ActiveRun, code: string, pid = process.pid): string {
	const dir = runtimeAgentDir();
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${runtimeAgentName(run.sessionKey, run.id, "eval", pid)}.js`);
	writeFileSync(path, code, "utf8");
	run.runtimeAgentPaths.push(path);
	return path;
}

export function evalResultPath(run: ActiveRun, pid = process.pid): string {
	return join(runtimeAgentDir(), `${runtimeAgentName(run.sessionKey, run.id, "result", pid)}.json`);
}

export function readEvalResult(run: ActiveRun): unknown {
	const path = run.runtimeAgentPaths.find((item) => item.endsWith(".json")) ?? evalResultPath(run);
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}



export function runtimeParticipantPrompt(label: string): string {
	return [
		`You are a run-scoped Council/Arena participant (${label}).`,
		"Work from concrete repository evidence. Separate facts, assumptions, risks, and preferences.",
		"Do not defer to another agent merely because it sounds confident.",
		"When assigned implementation work, make the requested changes in the isolated workspace and verify them with appropriate tooling.",
		"When challenged later, preserve correct conclusions but revise when competing evidence is stronger.",
		"Do not invoke /council or /arena.",
	].join("\n\n");
}

export function runtimeJudgePrompt(): string {
	return [
		"You are a blind technical judge for an implementation arena.",
		"Candidate model/provider identities are intentionally hidden from you.",
		"Judge only technical evidence: correctness, verification, code quality, simplicity, architecture, regressions, and task fit.",
		"Do not attempt to infer model/provider identity. Prefer a smaller correct implementation over speculative complexity.",
		"Do not invoke /council or /arena.",
	].join("\n\n");
}

function yamlList(values: string[]): string {
	return `[${values.join(", ")}]`;
}

export function writeRuntimeAgentFile(
	name: string,
	model: string,
	description: string,
	prompt: string,
	kind: RunKind | "judge",
): string {
	const dir = runtimeAgentDir();
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${name}.md`);
	const tools = kind === "arena" ? ARENA_TOOLS : kind === "judge" ? JUDGE_TOOLS : COUNCIL_TOOLS;
	const body = [
		"---",
		`name: ${name}`,
		`description: ${JSON.stringify(description)}`,
		`model: ${JSON.stringify(model)}`,
		`tools: ${yamlList(tools)}`,
		"blocking: true",
		"---",
		"",
		prompt,
		"",
	].join("\n");
	writeFileSync(path, body, "utf8");
	return path;
}

export function materializeRuntimeAgents(run: ActiveRun): void {
	cleanupRuntimeAgents(run);
	const paths: string[] = [];
	for (const participant of run.participants) {
		paths.push(
			writeRuntimeAgentFile(
				participant.agent,
				participant.model,
				`Run-scoped Council/Arena seat for ${participant.label}.`,
				runtimeParticipantPrompt(participant.label),
				run.kind,
			),
		);
	}
	if (run.kind === "arena" && run.judgeAgent && run.judgeModel) {
		paths.push(
			writeRuntimeAgentFile(
				run.judgeAgent,
				run.judgeModel,
				"Run-scoped blind Arena judge.",
				runtimeJudgePrompt(),
				"judge",
			),
		);
	}
	run.runtimeAgentPaths = paths;
}

export function cleanupRuntimeAgents(run: Pick<ActiveRun, "runtimeAgentPaths">): string[] {
	const removed: string[] = [];
	for (const path of run.runtimeAgentPaths ?? []) {
		try {
			if (existsSync(path)) {
				unlinkSync(path);
				removed.push(path);
			}
		} catch {
			// Best effort. Uniquely named; never reused.
		}
	}
	run.runtimeAgentPaths = [];
	return removed;
}

export function cleanupRuntimeAgentsByPrefix(instanceId: string, pid = process.pid): string[] {
	const dir = runtimeAgentDir();
	if (!existsSync(dir)) return [];
	const prefix = `${RUNTIME_AGENT_PREFIX}-${pid}-${slug(instanceId)}-`;
	const removed: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (!entry.startsWith(prefix) || !(entry.endsWith(".md") || entry.endsWith(".js") || entry.endsWith(".json"))) continue;


		const path = join(dir, entry);
		try {
			unlinkSync(path);
			removed.push(path);
		} catch {
			// Best effort.
		}
	}
	return removed;
}

const SEAT_TRANSCRIPT = /^(?:C|A)\d+-(?:seat\d+-position|candidate-[A-Z]|blind-judge)(?:\.jsonl|\.json|\.md)$/;

export function cleanupSeatTranscripts(parentSessionFile: string | undefined, runId?: string): string[] {
	if (!parentSessionFile) return [];
	const dir = dirname(parentSessionFile);
	if (!existsSync(dir)) return [];
	const prefix = runId ? `${runId}-` : undefined;
	const removed: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (prefix && !entry.startsWith(prefix)) continue;
		if (!SEAT_TRANSCRIPT.test(entry)) continue;
		const path = join(dir, entry);
		try {
			if (entry.endsWith(".jsonl")) {
				try {
					writeFileSync(`${path}.tombstone`, "");
				} catch {
					// Tombstone is best-effort; unlink still hides the transcript.
				}
			}
			unlinkSync(path);
			removed.push(path);
		} catch {
			// Best effort. Hub re-adopts leftover jsonl as parked agents.
		}
	}
	return removed;
}

export function isOwnChildSession(sessionName: string | undefined, sessionFile: string | undefined): boolean {
	const haystack = `${sessionName ?? ""} ${sessionFile ?? ""}`.toLowerCase();
	return haystack.includes(RUNTIME_AGENT_PREFIX);
}

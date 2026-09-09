import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { retainLimit } from "./config.ts";
import { agentDir, runDumpsPath } from "./paths.ts";
import { runtimeAgentName } from "./runtime-agents.ts";
import { DEFAULT_RETAIN_RUNS, ROLE_LENSES, STATE_ENTRY, isTerminalPhase } from "./types.ts";
import type {
	ActiveRun,
	ArenaProfile,
	CouncilMode,
	MemberState,
	MemberStatus,
	RolePreset,
	RunKind,
	RunParticipant,
	RuntimeState,
	RunArchive,
	SelectedParticipant,
} from "./types.ts";
import { renderWidget, runLabel } from "./widget.ts";

export function sessionKeyOf(ctx: ExtensionContext | ExtensionCommandContext): string {
	return ctx.sessionManager.getSessionId() || ctx.sessionManager.getSessionFile() || "unknown-session";
}

export function createRuntimeState(sessionKey: string): RuntimeState {
	return {
		sequence: 0,
		history: [],
		instanceId: `${sessionKey.slice(0, 12)}-${Math.random().toString(36).slice(2, 8)}`,
		sessionKey,
	};
}

export function assignLenses(count: number, preset: RolePreset, seq: number): string[] {
	const lenses = ROLE_LENSES[preset];
	const offset = lenses.length ? seq % lenses.length : 0;
	return Array.from({ length: count }, (_, index) => lenses[(index + offset) % lenses.length] ?? ROLE_LENSES.general[0]);
}

export function makeRun(
	state: RuntimeState,
	kind: RunKind,
	question: string,
	selected: SelectedParticipant[],
	options: {
		temporary: boolean;
		mode?: CouncilMode;
		rolePreset?: RolePreset;
		arenaProfile?: ArenaProfile;
		judgeModel?: string;
	},
): ActiveRun {
	state.sequence += 1;
	const id = `${kind === "council" ? "C" : "A"}${state.sequence}`;
	const rolePreset = options.rolePreset ?? "general";
	const lenses = assignLenses(selected.length, rolePreset, state.sequence);
	const participants: RunParticipant[] = selected.map((participant, index) => {
		const key = `seat${index + 1}`;
		return {
			...participant,
			key,
			agent: runtimeAgentName(state.instanceId, id, key),
			lens: lenses[index],
		};
	});
	const members: Record<string, MemberState> = {};
	for (const participant of participants) {
		members[participant.key] = {
			key: participant.key,
			label: participant.label,
			model: participant.model,
			lens: participant.lens,
			status: "queued",
			stage: kind === "council" ? "position" : "implementation",
			stages: {},
		};
	}
	if (kind === "arena") {
		members.judge = {
			key: "judge",
			label: "Judge",
			model: options.judgeModel ?? "",
			status: "queued",
			stage: "judging",
			stages: {},
		};
	}

	return {
		id,
		seq: state.sequence,
		kind,
		sessionKey: state.sessionKey,
		question,
		participants,
		temporary: options.temporary,
		phase: "queued",
		startedAt: Date.now(),
		awaitingEval: true,
		cancelRequested: false,
		mode: options.mode,
		rolePreset,
		arenaProfile: options.arenaProfile,
		judgeModel: options.judgeModel,
		judgeAgent: kind === "arena" ? runtimeAgentName(state.instanceId, id, "judge") : undefined,
		runtimeAgentPaths: [],
		members,
	};
}

export function applyProgress(
	run: ActiveRun,
	params: {
		phase?: string;
		member?: string;
		status?: string;
		message?: string;
		cost?: number;
		durationMs?: number;
		model?: string;
	},
): void {
	if (params.phase) run.phase = params.phase as ActiveRun["phase"];
	if (!params.member && params.message) run.statusMessage = params.message.slice(0, 64);
	const member = params.member ? run.members[params.member] : undefined;
	if (!member) return;
	if (params.status === "queued" || params.status === "running" || params.status === "done" || params.status === "failed" || params.status === "cancelled") {
		member.status = params.status;
		if (params.phase) member.stages[params.phase] = params.status;
		if (params.status === "running") member.startedAt ??= Date.now();
		if ((params.status === "done" || params.status === "failed" || params.status === "cancelled") && member.startedAt && params.durationMs === undefined) {
			member.durationMs ??= Date.now() - member.startedAt;
		}
	}
	if (params.phase) member.stage = params.phase;
	member.note = params.message?.slice(0, 48);
	if (typeof params.durationMs === "number" && Number.isFinite(params.durationMs) && params.durationMs >= 0) {
		member.durationMs = (member.durationMs ?? 0) + params.durationMs;
	}
	if (typeof params.cost === "number" && Number.isFinite(params.cost) && params.cost >= 0) {
		member.cost = params.cost;
	}
	if (params.model) {
		member.resolvedModel = params.model;
		member.fallback = !modelsMatch(member.model, params.model);
	}
}

function modelsMatch(requested: string, resolved: string): boolean {
	const a = requested.trim().toLowerCase();
	const b = resolved.trim().toLowerCase();
	if (!a || !b) return true;
	if (a === b) return true;
	if (a.includes(b) || b.includes(a)) return true;
	const tail = (value: string) => value.split("/").pop()?.replace(/[^a-z0-9]+/g, "") ?? value;
	return tail(a) === tail(b);
}

function collectStatusEvents(details: unknown): Array<Record<string, unknown>> {
	if (!details || typeof details !== "object") return [];
	const record = details as Record<string, unknown>;
	const events: Array<Record<string, unknown>> = [];
	const push = (value: unknown) => {
		if (!Array.isArray(value)) return;
		for (const event of value) {
			if (event && typeof event === "object" && !Array.isArray(event)) events.push(event as Record<string, unknown>);
		}
	};
	push(record.statusEvents);
	if (Array.isArray(record.cells)) {
		for (const cell of record.cells) {
			if (cell && typeof cell === "object") push((cell as Record<string, unknown>).statusEvents);
		}
	}
	return events;
}

export function memberKeyFromAgentEvent(run: ActiveRun, id: string): string | undefined {
	const seat = id.match(/-(seat\d+)(?:-|$)/);
	if (seat?.[1] && run.members[seat[1]]) return seat[1];
	if (/(?:^|-)(?:blind-)?judge$/i.test(id) && run.members.judge) return "judge";
	const candidate = id.match(/-candidate-([A-Z])$/i);
	if (candidate?.[1]) {
		const key = `seat${candidate[1].toUpperCase().charCodeAt(0) - 64}`;
		if (run.members[key]) return key;
	}
	return undefined;
}

export function hydrateUsageFromEval(run: ActiveRun, details: unknown): void {
	for (const event of collectStatusEvents(details)) {
		if (event.op !== "agent") continue;
		const id = typeof event.id === "string" ? event.id : "";
		if (!id) continue;
		const key = memberKeyFromAgentEvent(run, id);
		if (!key) continue;
		const member = run.members[key];
		if (!member) continue;
		const cost = typeof event.cost === "number" ? event.cost : Number(event.cost);
		if (Number.isFinite(cost) && cost >= 0) member.cost = cost;
		const durationMs = typeof event.durationMs === "number" ? event.durationMs : Number(event.durationMs);
		if (Number.isFinite(durationMs) && durationMs >= 0) member.durationMs = durationMs;
		const model = typeof event.model === "string" ? event.model : undefined;
		if (model) {
			member.resolvedModel = model;
			member.fallback = event.resolvedModelIsFallback === true || !modelsMatch(member.model, model);
		} else if (event.resolvedModelIsFallback === true) {
			member.fallback = true;
		}
	}
}

export function freezeRunClock(run: ActiveRun): void {
	run.finishedAt ??= Date.now();
}

function memberResults(value: unknown): Array<{ member?: string; error?: unknown }> {
	return Array.isArray(value) ? (value as Array<{ member?: string; error?: unknown }>) : [];
}

export function applyOrchestrationResult(run: ActiveRun, final: unknown): void {
	if (!final || typeof final !== "object") return;
	const record = final as Record<string, unknown>;
	const apply = (items: Array<{ member?: string; error?: unknown }>, phase: string) => {
		for (const item of items) {
			if (!item?.member) continue;
			applyProgress(run, {
				phase,
				member: item.member,
				status: item.error ? "failed" : "done",
				message: item.error ? String(item.error) : "complete",
			});
		}
	};
	if (run.kind === "council") {
		apply(memberResults(record.initial), "independent");
		apply(memberResults(record.rebuttals), "rebuttal");
		apply(memberResults(record.finalReview), "final-review");
		return;
	}
	const candidates = Array.isArray(record.candidates) ? record.candidates : [];
	for (let i = 0; i < candidates.length; i += 1) {
		const candidate = candidates[i] as { error?: unknown };
		applyProgress(run, {
			phase: "implementing",
			member: `seat${i + 1}`,
			status: candidate?.error ? "failed" : "done",
			message: candidate?.error ? String(candidate.error) : "complete",
		});
	}
	if (record.judgement && run.members.judge) {
		applyProgress(run, { phase: "judging", member: "judge", status: "done", message: "complete" });
	}
}

export function snapshotRun(run: ActiveRun): RunArchive {
	freezeRunClock(run);
	return {
		id: run.id,
		kind: run.kind,
		question: run.question,
		participants: run.participants.map((p) => ({ label: p.label, model: p.model })),
		temporary: run.temporary,
		phase: run.phase,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt ?? Date.now(),
		mode: run.mode,
		rolePreset: run.rolePreset,
		arenaProfile: run.arenaProfile,
	};
}

export type RunDump = RunArchive & {
	members?: Record<string, unknown>;
	final?: unknown;
	statusMessage?: string;
};

function dropLegacyRunDir(): void {
	const legacy = join(agentDir(), "council-runs");
	if (!existsSync(legacy)) return;
	try {
		rmSync(legacy, { recursive: true, force: true });
	} catch {
		// Best effort. The jsonl ring is the store now.
	}
}

export function readRunDumps(kind: "council" | "arena"): RunDump[] {
	const path = runDumpsPath(kind);
	if (!existsSync(path)) return [];
	try {
		const rows: RunDump[] = [];
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const row = JSON.parse(line) as RunDump;
				if (row && typeof row.id === "string") rows.push(row);
			} catch {
				// Skip a corrupt line; keep the rest of the ring.
			}
		}
		return rows;
	} catch {
		return [];
	}
}

export function persistRunDump(run: ActiveRun): string | undefined {
	try {
		dropLegacyRunDir();
		const path = runDumpsPath(run.kind);
		const cap = retainLimit(run.kind);
		if (cap <= 0) {
			writeFileSync(path, "");
			return path;
		}
		const members: Record<string, unknown> = {};
		for (const [key, member] of Object.entries(run.members)) {
			members[key] = {
				label: member.label,
				model: member.model,
				status: member.status,
				stage: member.stage,
				cost: member.cost,
				durationMs: member.durationMs,
				resolvedModel: member.resolvedModel,
				fallback: member.fallback,
			};
		}
		const body: RunDump = {
			...snapshotRun(run),
			members,
			final: run.final ?? null,
			statusMessage: run.statusMessage,
		};
		const rows = [body, ...readRunDumps(run.kind).filter((row) => row.id !== run.id)].slice(0, cap);
		writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
		return path;
	} catch {
		return undefined;
	}
}

export function archiveRun(pi: ExtensionAPI, state: RuntimeState, run: ActiveRun): void {
	if (run.archived) return;
	run.archived = true;
	persistRunDump(run);
	const archived = snapshotRun(run);
	state.history = [archived, ...state.history.filter((item) => item.id !== archived.id)].slice(0, DEFAULT_RETAIN_RUNS);
	pi.appendEntry(STATE_ENTRY, archived);
}

export function ensureNoActiveRun(state: RuntimeState, ctx: ExtensionCommandContext): boolean {
	if (!state.activeRun || isTerminalPhase(state.activeRun.phase)) return true;
	ctx.ui.notify(`${runLabel(state.activeRun)} is still active. Use /${state.activeRun.kind} cancel first.`, "warning");
	renderWidget(state, ctx);
	return false;
}

function summarizeDump(item: RunDump): string {
	const when = new Date(item.finishedAt).toLocaleString();
	const detail = item.kind === "council" ? `${item.mode}/${item.rolePreset}` : item.arenaProfile;
	const models = item.participants.map((p) => p.label).join(" + ");
	const q = item.question.replace(/\s+/g, " ").slice(0, 80);
	return `${item.id}${item.temporary ? " tmp" : ""} ${item.kind} ${detail} • ${models} • ${when}\n  ${q}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function stringLines(value: unknown): string[] {
	if (typeof value === "string" && value.trim()) return [value.trim()];
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
}

function formatOpinion(label: string, item: unknown): string {
	const rec = asRecord(item);
	if (!rec) return label;
	const bits = [label];
	if (rec.error) bits.push(String(rec.error));
	const data = asRecord(rec.data);
	if (data) {
		if (typeof data.recommendation === "string") bits.push(data.recommendation);
		for (const line of stringLines(data.reasoning)) bits.push(`- ${line}`);
		if (typeof data.confidence === "number") bits.push(`confidence ${data.confidence}`);
	}
	return bits.join("\n");
}

export function historyReplayText(row: RunDump): string {
	const detail = row.kind === "arena" ? row.arenaProfile : `${row.mode ?? ""}/${row.rolePreset ?? ""}`.replace(/^\/|\/$/g, "");
	const seats = row.participants.map((p) => p.label).join(", ");
	const when = new Date(row.finishedAt).toLocaleString();
	const head = [row.temporary ? "tmp" : undefined, detail || undefined, seats || undefined, when].filter(Boolean).join(" · ");
	const parts = [head, "", row.question.replace(/\s+/g, " ").trim()];
	const final = asRecord(row.final);
	if (!final) {
		if (row.statusMessage || row.phase) parts.push("", String(row.statusMessage ?? row.phase));
		return parts.join("\n");
	}
	if (row.kind === "arena" || final.kind === "arena") {
		const judgement = asRecord(final.judgement);
		if (judgement) {
			const winner = typeof judgement.winner === "string" ? judgement.winner : "?";
			const conf = typeof judgement.confidence === "number" ? ` · ${judgement.confidence}` : "";
			parts.push("", `Winner ${winner}${conf}`);
			if (typeof judgement.decision === "string") parts.push(judgement.decision);
		}
		const reveal = asRecord(final.reveal);
		const candidates = Array.isArray(final.candidates) ? final.candidates : [];
		for (const item of candidates) {
			const cand = asRecord(item);
			if (!cand) continue;
			const letter = String(cand.candidate ?? "?");
			const who = asRecord(reveal?.[letter]);
			const name = typeof who?.label === "string" ? ` · ${who.label}` : "";
			parts.push("", `Candidate ${letter}${name}`);
			if (cand.error) parts.push(String(cand.error));
			const data = asRecord(cand.data);
			if (typeof data?.summary === "string") parts.push(data.summary);
			if (typeof data?.approach === "string" && data.approach !== data.summary) parts.push(data.approach);
		}
		return parts.join("\n");
	}
	const round = Array.isArray(final.finalReview)
		? final.finalReview
		: Array.isArray(final.rebuttals)
			? final.rebuttals
			: Array.isArray(final.initial)
				? final.initial
				: [];
	const named = Array.isArray(final.participants) ? final.participants : [];
	for (const item of round) {
		const rec = asRecord(item);
		const key = rec && typeof rec.member === "string" ? rec.member : "";
		const seat = named.map(asRecord).find((p) => p?.key === key);
		const label = typeof seat?.label === "string" ? seat.label : key || "Seat";
		parts.push("", formatOpinion(label, item));
	}
	return parts.join("\n");
}

export function historyText(kind: "council" | "arena"): string {
	const path = runDumpsPath(kind);
	const cap = retainLimit(kind);
	const rows = readRunDumps(kind);
	const label = kind === "arena" ? "Arena" : "Council";
	if (rows.length === 0) return `No retained ${label} runs.\nLast ${cap} live in ${path}`;
	return `${rows.slice(0, 10).map(summarizeDump).join("\n")}\n\n${path}  (cap ${cap})`;
}

export function markMembers(run: ActiveRun, from: MemberStatus[], to: MemberStatus): void {
	for (const member of Object.values(run.members)) {
		if (from.includes(member.status)) member.status = to;
	}
}

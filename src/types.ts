export type RunKind = "council" | "arena";
export type CouncilMode = "quick" | "debate" | "deep";
export type RolePreset = "general" | "architecture" | "debug" | "security" | "refactor";
export type ArenaProfile = "auto" | "general" | "rust";
export type RunPhase =
	| "queued"
	| "starting"
	| "independent"
	| "rebuttal"
	| "final-review"
	| "implementing"
	| "judging"
	| "synthesizing"
	| "done"
	| "cancelling"
	| "cancelled"
	| "failed";
export type MemberStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface ModelLike {
	provider: string;
	id: string;
	name?: string;
}

export interface ParticipantConfig {
	id: string;
	label: string;
	model: string;
	aliases?: string[];
	tags?: string[];
}

export interface CouncilConfig {
	version: 1;
	participants: ParticipantConfig[];
	presets?: Record<string, string[]>;
	judgeModel?: string;
	shimmer?: boolean;
	retainCouncil?: number;
	retainArena?: number;
}

export interface SelectedParticipant {
	registryId?: string;
	label: string;
	model: string;
	provider: string;
	temporary: boolean;
}

export interface RunParticipant extends SelectedParticipant {
	key: string;
	agent: string;
	lens: string;
}

export interface MemberState {
	key: string;
	label: string;
	model: string;
	lens?: string;
	status: MemberStatus;
	stage: string;
	stages: Record<string, MemberStatus>;
	note?: string;
	startedAt?: number;
	durationMs?: number;
	cost?: number;
	resolvedModel?: string;
	fallback?: boolean;
}

export interface ArenaTest {
	command: string;
	status: "pass" | "fail" | "not-run";
	summary: string;
}

export interface ArenaCandidateResult {
	candidate: string;
	data?: {
		approach?: string;
		summary?: string;
		filesChanged?: string[];
		tests?: ArenaTest[];
		risks?: string[];
		confidence?: number;
		diff?: string;
		diffTruncated?: boolean;
	};
	error?: string;
}

export interface ArenaJudgement {
	winner?: string;
	decision?: string;
	confidence?: number;
	rankings?: Array<{ candidate?: string; score?: number; reason?: string }>;
}

export interface ArenaFinalResult {
	kind?: "arena";
	runId?: string;
	profile?: string;
	candidates?: ArenaCandidateResult[];
	judgement?: ArenaJudgement;
	reveal?: Record<string, { label?: string; model?: string; handle?: string }>;
}

export interface ActiveRun {
	id: string;
	seq: number;
	kind: RunKind;
	sessionKey: string;
	question: string;
	participants: RunParticipant[];
	temporary: boolean;
	phase: RunPhase;
	startedAt: number;
	finishedAt?: number;
	awaitingEval: boolean;
	evalToolCallId?: string;
	cancelRequested: boolean;
	statusMessage?: string;
	mode?: CouncilMode;
	rolePreset?: RolePreset;
	arenaProfile?: ArenaProfile;
	judgeModel?: string;
	judgeAgent?: string;
	runtimeAgentPaths: string[];
	members: Record<string, MemberState>;
	final?: unknown;
	ruling?: string;
	archived?: boolean;
	editorSnapshot?: string;
}

export interface RunArchive {
	id: string;
	kind: RunKind;
	question: string;
	participants: Array<{ label: string; model: string }>;
	temporary: boolean;
	phase: RunPhase;
	startedAt: number;
	finishedAt: number;
	mode?: CouncilMode;
	rolePreset?: RolePreset;
	arenaProfile?: ArenaProfile;
	dumpPath?: string;
}

export interface RuntimeState {
	activeRun?: ActiveRun;
	sequence: number;
	history: RunArchive[];
	instanceId: string;
	sessionKey: string;
	detachCancel?: () => void;
	detachHistory?: () => void;
	confirmingCancel?: boolean;
}

export interface CouncilSyntax {
	temporary: boolean;
	participantTokens: string[];
	mode: CouncilMode;
	modeSpecified: boolean;
	rolePreset: RolePreset;
	roleSpecified: boolean;
	question?: string;
}

export interface ArenaSyntax {
	temporary: boolean;
	participantTokens: string[];
	arenaProfile: ArenaProfile;
	profileSpecified: boolean;
	judgeToken?: string;
	question?: string;
}

export const ROLE_LENSES: Record<RolePreset, string[]> = {
	general: [
		"independent senior engineer; optimize for correctness and pragmatic tradeoffs",
		"independent senior engineer; challenge assumptions and compare alternatives",
		"independent senior engineer; focus on maintainability and failure modes",
		"independent senior engineer; seek simpler or non-obvious approaches",
	],
	architecture: [
		"systems architect: boundaries, invariants, coupling, evolvability",
		"implementation reviewer: feasibility, migration cost, operational details",
		"red-team architect: attack assumptions, failure modes, hidden coupling",
		"simplifier: seek the smallest design that preserves required capabilities",
	],
	debug: [
		"causal investigator: rank root-cause hypotheses and falsifying evidence",
		"code-path tracer: follow concrete control/data flow and state transitions",
		"adversarial debugger: attack the leading hypothesis and find counterexamples",
		"reproduction specialist: isolate minimal repro, observability, and verification",
	],
	security: [
		"threat modeler: assets, trust boundaries, attacker capabilities, abuse paths",
		"exploit reviewer: identify concrete exploitability and preconditions",
		"defense reviewer: mitigations, least privilege, secure defaults, regressions",
		"skeptical verifier: distinguish theoretical concerns from demonstrable risk",
	],
	refactor: [
		"architecture refactorer: improve module boundaries and responsibility placement",
		"API ergonomics reviewer: simplify interfaces without rebuilding framework traits",
		"maintenance reviewer: reduce accidental complexity, duplication, and slop",
		"regression reviewer: preserve behavior, tests, compatibility, and incremental rollout",
	],
};

export const TERMINAL_PHASES = new Set<RunPhase>(["done", "cancelled", "failed"]);
export const STATE_ENTRY = "dev.omp.council.run";
export const KICKOFF_TYPE = "omp-council.kickoff";
export const HISTORY_TYPE = "omp-council.history";

export const WIDGET_KEY = "omp-council";
export const HISTORY_WIDGET_KEY = "omp-council-history";
export const STATUS_KEY = "omp-council";
export const MAX_PARTICIPANTS = 8;
export const MIN_PARTICIPANTS = 2;
export const DEFAULT_RETAIN_RUNS = 20;
export const MAX_RETAIN_RUNS = 200;
export const CONFIG_FILENAME = "council.json";
export const ROLE_PRESETS = ["general", "architecture", "debug", "security", "refactor"] as const;
export function isTerminalPhase(phase: RunPhase): boolean {
	return phase === "done" || phase === "cancelled" || phase === "failed";
}
export const ARENA_PROFILES = ["auto", "general", "rust"] as const;
export const RUNTIME_AGENT_PREFIX = "omp-council";

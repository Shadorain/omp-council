import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "@oh-my-pi/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { configSummary, readConfig } from "./config.ts";
import { currentModelSelector, exactSelector } from "./models.ts";
import {
	applyChairSystemPrompt,
	chairTurnContent,
	evalInputFor,
	findFinalJson,
	isChairPlumbing,
	isKickoffPrompt,
	kickoffDetails,
	KICKOFF_TYPE,
	sessionStopNudge,
} from "./orchestration.ts";

import {
	type ArgumentCompletion,
	arenaArgumentCompletions,
	councilArgumentCompletions,
} from "./completions.ts";
import { parseArenaSyntax, parseCouncilSyntax } from "./parse.ts";
import { councilConfigPath } from "./paths.ts";
import { preselectedFromTokens, resolveParticipantTokens, selectedFromConfig, splitBarePrompt } from "./participants.ts";
import {
	cleanupRuntimeAgents,
	cleanupRuntimeAgentsByPrefix,
	cleanupSeatTranscripts,
	isOwnChildSession,
	materializeRuntimeAgents,
	readEvalResult,
} from "./runtime-agents.ts";

import {
	applyOrchestrationResult,
	applyProgress,
	archiveRun,
	createRuntimeState,
	ensureNoActiveRun,
	freezeRunClock,
	historyText,
	hydrateUsageFromEval,
	makeRun,
	markMembers,
	sessionKeyOf,
} from "./state.ts";
import {
	MIN_PARTICIPANTS,
	STATE_ENTRY,
	STATUS_KEY,
	WIDGET_KEY,
	isTerminalPhase,
	type ActiveRun,
	type ArenaFinalResult,
	type ArenaProfile,
	type ArenaSyntax,
	type CouncilConfig,
	type CouncilMode,
	type CouncilSyntax,
	type RolePreset,
	type RuntimeState,
	type SelectedParticipant,
} from "./types.ts";

import {
	pickConfiguredParticipants,
	pickJudgeModel,
	pickModelSelectors,
	promptArenaProfile,
	promptCouncilForm,
	promptCouncilMode,
	promptRolePreset,
	selectorsToParticipants,
	setupRegistry,
} from "./ui.ts";
import { isCouncilCancel, kickoffRenderer, participantLabels, renderWidget, runLabel } from "./widget.ts";


function usageText(): string {
	return [
		"How to run Council / Arena",
		"",
		"Council = several models review a question. Arena = several models compete on an implementation.",
		"",
		"1. /council",
		"   First time: pick 2-8 models to save.",
		"   Then: check seats, pick Quick / Debate / Deep, pick a role, type the question.",
		"2. Watch the widget. Esc (confirm) or /council cancel stops the run.",
		"3. Chair writes the decision after the seats finish. No majority vote.",
		"",
		"Skip saving:  /council -t",
		"Skip the form:  /council --deep --role architecture -- Review this boundary.",
		"",
		"Arena:",
		"  /arena",
		"  /arena -t --profile rust -- Implement this refactor.",
		"  Winner never auto-applies. /arena apply checks the patch, then asks.",
		"",
		"Also: status | history | history C14 | clear | setup | config",
		`Registry: ${councilConfigPath()}`,
	].join("\n");
}

function argumentCompletions(kind: "council" | "arena", prefix: string): ArgumentCompletion[] | null {
	const items = kind === "council" ? councilArgumentCompletions(prefix) : arenaArgumentCompletions(prefix);
	return items.length > 0 ? items : null;
}

async function buildCouncilRequest(
	ctx: ExtensionCommandContext,
	syntax: CouncilSyntax,
	rawWasEmpty: boolean,
): Promise<
	| {
			participants: SelectedParticipant[];
			mode: CouncilMode;
			rolePreset: RolePreset;
			question: string;
			temporary: boolean;
	  }
	| undefined
> {
	let participants: SelectedParticipant[];
	let config: CouncilConfig | undefined;
	let question = syntax.question;

	if (syntax.temporary) {
		const selectors = await pickModelSelectors(
			ctx,
			"Temporary Council — authenticated models",
			preselectedFromTokens(ctx, syntax.participantTokens),
		);
		if (!selectors) return undefined;
		participants = selectorsToParticipants(ctx, selectors, true);
	} else if (syntax.participantTokens.length > 0) {
		config = readConfig();
		const split = question ? { participantTokens: syntax.participantTokens, question } : splitBarePrompt(ctx, config, syntax.participantTokens);
		participants = resolveParticipantTokens(ctx, config, split.participantTokens);
		question = split.question ?? question;
	} else {
		config = readConfig();
		if (!config) {
			ctx.ui.notify("First run: pick 2-8 models to save. `-t` skips saving.", "info");
			config = await setupRegistry(ctx);
			if (!config) return undefined;
		}
		if (syntax.question && !rawWasEmpty) {
			participants = resolveParticipantTokens(ctx, config, []);
		} else {
			const formChoices = config.participants
				.filter((participant) => !!exactSelector(ctx, participant.model))
				.map((participant) => ({
					label: `${participant.label}  [${participant.id}]`,
					description: participant.model,
				}));
			const form = formChoices.length >= MIN_PARTICIPANTS
				? await promptCouncilForm(ctx, {
						participantChoices: formChoices,
						initialChecked: [],
						includeMode: !syntax.modeSpecified && !syntax.question,
						includeRole: !syntax.roleSpecified && !syntax.question,
						title: "Council",
					})
				: undefined;
			if (form) {
				const picked = config.participants.filter((participant) =>
					form.selectedLabels.includes(`${participant.label}  [${participant.id}]`),
				);
				participants = picked.map((participant) => selectedFromConfig(ctx, participant));
				if (!syntax.modeSpecified && form.mode) {
					syntax.mode = form.mode;
					syntax.modeSpecified = true;
				}
				if (!syntax.roleSpecified && form.role) {
					syntax.rolePreset = form.role;
					syntax.roleSpecified = true;
				}
			} else {
				const picked = await pickConfiguredParticipants(ctx, config);
				if (!picked) return undefined;
				participants = picked;
			}
		}
	}

	let mode = syntax.mode;
	let rolePreset = syntax.rolePreset;

	if (!question) {
		if (!syntax.modeSpecified) {
			const pickedMode = await promptCouncilMode(ctx);
			if (!pickedMode) return undefined;
			mode = pickedMode;
		}
		if (!syntax.roleSpecified) {
			const pickedRole = await promptRolePreset(ctx);
			if (!pickedRole) return undefined;
			rolePreset = pickedRole;
		}
		question = (await ctx.ui.editor("Prompt", "", undefined, { promptStyle: true }))?.trim();
		if (!question) return undefined;
	}

	return { participants, mode, rolePreset, question, temporary: syntax.temporary };
}

async function resolveArenaJudge(
	ctx: ExtensionCommandContext,
	config: CouncilConfig | undefined,
	syntax: ArenaSyntax,
): Promise<string | undefined> {
	if (syntax.judgeToken) {
		const exact = exactSelector(ctx, syntax.judgeToken);
		if (!exact) throw new Error(`Arena judge model does not resolve: ${syntax.judgeToken}`);
		return exact;
	}
	if (syntax.temporary) {
		const picked = await pickJudgeModel(ctx, undefined, "Temporary Arena — blind judge model");
		if (picked === null) return undefined;
		return picked ?? currentModelSelector(ctx);
	}
	if (config?.judgeModel) {
		const exact = exactSelector(ctx, config.judgeModel);
		if (exact) return config.judgeModel;
		ctx.ui.notify(
			`Saved Arena judge no longer resolves (${config.judgeModel}); falling back to the current session model.`,
			"warning",
		);
	}
	return currentModelSelector(ctx);
}

async function buildArenaRequest(
	ctx: ExtensionCommandContext,
	syntax: ArenaSyntax,
	rawWasEmpty: boolean,
): Promise<
	| {
			participants: SelectedParticipant[];
			arenaProfile: ArenaProfile;
			judgeModel: string;
			question: string;
			temporary: boolean;
	  }
	| undefined
> {
	let participants: SelectedParticipant[];
	let config: CouncilConfig | undefined;
	let question = syntax.question;

	if (syntax.temporary) {
		const selectors = await pickModelSelectors(
			ctx,
			"Temporary Arena — candidate models",
			preselectedFromTokens(ctx, syntax.participantTokens),
		);
		if (!selectors) return undefined;
		participants = selectorsToParticipants(ctx, selectors, true);
	} else if (syntax.participantTokens.length > 0) {
		config = readConfig();
		const split = question ? { participantTokens: syntax.participantTokens, question } : splitBarePrompt(ctx, config, syntax.participantTokens);
		participants = resolveParticipantTokens(ctx, config, split.participantTokens);
		question = split.question ?? question;
	} else {
		config = readConfig();
		if (!config) {
			ctx.ui.notify("First run: pick 2-8 models to save. `-t` skips saving.", "info");
			config = await setupRegistry(ctx);
			if (!config) return undefined;
		}
		if (syntax.question && !rawWasEmpty) {
			participants = resolveParticipantTokens(ctx, config, []);
		} else {
			const picked = await pickConfiguredParticipants(ctx, config);
			if (!picked) return undefined;
			participants = picked;
		}
	}

	let profile = syntax.arenaProfile;
	if (!question) {
		if (!syntax.profileSpecified) {
			const pickedProfile = await promptArenaProfile(ctx);
			if (!pickedProfile) return undefined;
			profile = pickedProfile;
		}
		question = (await ctx.ui.editor("Arena implementation task", "", undefined, { promptStyle: true }))?.trim();
		if (!question) return undefined;
	}

	if (profile === "auto") profile = existsSync(join(ctx.cwd, "Cargo.toml")) ? "rust" : "general";
	const judgeModel = await resolveArenaJudge(ctx, config, syntax);
	if (!judgeModel) {
		ctx.ui.notify(
			"Arena needs a resolvable judge model. Pick one with --judge or choose one in temporary/setup UI.",
			"error",
		);
		return undefined;
	}

	return { participants, arenaProfile: profile, judgeModel, question, temporary: syntax.temporary };
}

function validateRuntime(pi: ExtensionAPI): string | undefined {
	if (!pi.getActiveTools().includes("eval")) {
		return "OMP eval is not active. Enable the JavaScript eval backend/tool before starting Council or Arena.";
	}
	return undefined;
}

function detachRunCancel(state: RuntimeState): void {
	state.detachCancel?.();
	state.detachCancel = undefined;
	state.confirmingCancel = false;
}

async function ensureProgressTool(pi: ExtensionAPI): Promise<void> {
	const names = pi.getActiveTools();
	if (names.includes("council_progress")) return;
	await pi.setActiveTools([...names, "council_progress"]);
}


function restoreEditorAfterCancel(
	ctx: ExtensionCommandContext,
	run: { editorSnapshot?: string; question?: string },
): void {
	const current = ctx.ui.getEditorText();
	const snapshot = run.editorSnapshot ?? "";
	if (!isKickoffPrompt(current) && current !== (run.question ?? "") && current.trim().length > 0) return;
	ctx.ui.setEditorText(isKickoffPrompt(snapshot) ? "" : snapshot);
}

function attachEscCancel(pi: ExtensionAPI, state: RuntimeState, ctx: ExtensionCommandContext): void {
	detachRunCancel(state);
	state.detachCancel = ctx.ui.onTerminalInput((data) => {
		if (!isCouncilCancel(data)) return;
		if (!state.activeRun || isTerminalPhase(state.activeRun.phase) || state.activeRun.cancelRequested) return;
		if (state.confirmingCancel) return { consume: true };
		state.confirmingCancel = true;
		void (async () => {
			try {
				const run = state.activeRun;
				if (!run || isTerminalPhase(run.phase)) return;
				const ok = await ctx.ui.confirm(
					`Cancel ${runLabel(run)}?`,
					"Abort this run and all child agents.",
				);
				if (ok && state.activeRun && !isTerminalPhase(state.activeRun.phase)) {
					await cancelActive(pi, state, ctx);
				}


			} finally {
				state.confirmingCancel = false;
			}
		})();
		return { consume: true };
	});
}

async function startCouncil(
	pi: ExtensionAPI,
	state: RuntimeState,
	request: {
		participants: SelectedParticipant[];
		mode: CouncilMode;
		rolePreset: RolePreset;
		question: string;
		temporary: boolean;
	},
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!ensureNoActiveRun(state, ctx)) return;
	const runtimeValidation = validateRuntime(pi);
	if (runtimeValidation) {
		ctx.ui.notify(runtimeValidation, "error");
		return;
	}
	const run = makeRun(state, "council", request.question, request.participants, {
		temporary: request.temporary,
		mode: request.mode,
		rolePreset: request.rolePreset,
	});
	state.activeRun = run;
	try {
		run.editorSnapshot = ctx.ui.getEditorText();
		await ensureProgressTool(pi);
		materializeRuntimeAgents(run);
		attachEscCancel(pi, state, ctx);
		renderWidget(state, ctx);
		ctx.ui.notify(`Starting ${runLabel(run)} with ${participantLabels(run.participants)}.`, "info");
		pi.sendMessage(
			{
				customType: KICKOFF_TYPE,
				content: chairTurnContent(run),
				display: true,
				attribution: "agent",
				details: kickoffDetails(run),
			},
			{ triggerTurn: true },
		);


	} catch (error) {
		detachRunCancel(state);
		scrubRun(state, run, sessionFileOf(ctx));
		if (state.activeRun === run) state.activeRun = undefined;
		renderWidget(state, ctx);
		throw error;
	}
}

async function startArena(
	pi: ExtensionAPI,
	state: RuntimeState,
	request: {
		participants: SelectedParticipant[];
		arenaProfile: ArenaProfile;
		judgeModel: string;
		question: string;
		temporary: boolean;
	},
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!ensureNoActiveRun(state, ctx)) return;
	const runtimeValidation = validateRuntime(pi);
	if (runtimeValidation) {
		ctx.ui.notify(runtimeValidation, "error");
		return;
	}
	const run = makeRun(state, "arena", request.question, request.participants, {
		temporary: request.temporary,
		arenaProfile: request.arenaProfile,
		judgeModel: request.judgeModel,
	});
	state.activeRun = run;
	try {
		run.editorSnapshot = ctx.ui.getEditorText();
		await ensureProgressTool(pi);
		materializeRuntimeAgents(run);
		attachEscCancel(pi, state, ctx);
		renderWidget(state, ctx);
		ctx.ui.notify(
			`Starting ${runLabel(run)} with ${participantLabels(run.participants)}; blind judge=${request.judgeModel}.`,
			"info",
		);
		pi.sendMessage(
			{
				customType: KICKOFF_TYPE,
				content: chairTurnContent(run),
				display: true,
				attribution: "agent",
				details: kickoffDetails(run),
			},
			{ triggerTurn: true },
		);


	} catch (error) {
		detachRunCancel(state);
		scrubRun(state, run, sessionFileOf(ctx));
		if (state.activeRun === run) state.activeRun = undefined;
		renderWidget(state, ctx);
		throw error;
	}
}
function sessionFileOf(ctx: { sessionManager: { getSessionFile?: () => string | null | undefined } }): string | undefined {
	return ctx.sessionManager.getSessionFile?.() ?? undefined;
}

function scrubRun(state: RuntimeState, run: ActiveRun, sessionFile?: string): void {
	freezeRunClock(run);
	cleanupRuntimeAgents(run);
	cleanupRuntimeAgentsByPrefix(state.instanceId);
	cleanupSeatTranscripts(sessionFile, run.id);
}

async function cancelActive(pi: ExtensionAPI, state: RuntimeState, ctx: ExtensionCommandContext): Promise<void> {
	if (!state.activeRun || isTerminalPhase(state.activeRun.phase)) {
		ctx.ui.notify("No active Council/Arena run to cancel.", "info");
		return;
	}
	const run = state.activeRun;
	run.cancelRequested = true;
	run.phase = "cancelling";
	markMembers(run, ["running", "queued"], "cancelled");
	renderWidget(state, ctx);
	ctx.abort();
	const idle = Promise.withResolvers<void>();
	const timer = setTimeout(idle.resolve, 2000);
	try {
		await Promise.race([ctx.waitForIdle(), idle.promise]);
	} catch {
		// Abort may reject waitForIdle; still clean up.
	} finally {
		clearTimeout(timer);
	}
	restoreEditorAfterCancel(ctx, run);
	scrubRun(state, run, sessionFileOf(ctx));
	run.phase = "cancelled";
	archiveRun(pi, state, run);
	detachRunCancel(state);
	renderWidget(state, ctx);
	ctx.ui.notify(`${runLabel(run)} cancelled.`, "warning");
}

async function applyArenaWinner(pi: ExtensionAPI, state: RuntimeState, ctx: ExtensionCommandContext): Promise<void> {
	if (!state.activeRun || state.activeRun.kind !== "arena" || state.activeRun.phase !== "done") {
		ctx.ui.notify("No completed Arena result is available to apply.", "warning");
		return;
	}
	const final = state.activeRun.final as ArenaFinalResult | undefined;
	const winner = final?.judgement?.winner;
	if (!winner) {
		ctx.ui.notify("Arena result has no winner.", "error");
		return;
	}
	const candidate = final?.candidates?.find((item) => item.candidate === winner);
	const diff = candidate?.data?.diff;
	if (!diff?.trim()) {
		ctx.ui.notify(
			`Winner ${winner} did not return an applyable diff. Use Agent Hub to inspect its isolated workspace/patch.`,
			"error",
		);
		return;
	}
	if (candidate?.data?.diffTruncated) {
		ctx.ui.notify(
			`Winner ${winner}'s reported diff was truncated; refusing partial apply. Use Agent Hub to inspect the candidate.`,
			"error",
		);
		return;
	}

	const reveal = final?.reveal?.[winner];
	const model = reveal?.model ?? winner;
	const dir = join(tmpdir(), "omp-council");
	mkdirSync(dir, { recursive: true });
	const patch = join(dir, `${state.activeRun.id}-${winner}.patch`);
	writeFileSync(patch, diff, "utf8");

	const check = await pi.exec("git", ["apply", "--check", patch], { cwd: ctx.cwd });
	if (check.code !== 0) {
		ctx.ui.notify(`Winner patch no longer applies cleanly:\n${check.stderr || check.stdout}`, "error");
		return;
	}
	const ok = await ctx.ui.confirm(
		"Apply Arena winner?",
		`Apply Candidate ${winner} (${model}) to the current working tree?\n\nThe patch passed git apply --check.`,
	);
	if (!ok) return;

	const result = await pi.exec("git", ["apply", patch], { cwd: ctx.cwd });
	if (result.code !== 0) {
		ctx.ui.notify(`git apply failed:\n${result.stderr || result.stdout}`, "error");
		return;
	}
	ctx.ui.notify(`Applied Candidate ${winner} (${model}) to the working tree.`, "info");
}

function clearCompletedRun(state: RuntimeState, ctx: ExtensionCommandContext): void {
	if (state.activeRun && !isTerminalPhase(state.activeRun.phase)) {
		ctx.ui.notify(`${runLabel(state.activeRun)} is still active. Cancel it before clearing.`, "warning");
		return;
	}
	if (state.activeRun) scrubRun(state, state.activeRun, sessionFileOf(ctx));
	else cleanupSeatTranscripts(sessionFileOf(ctx));
	detachRunCancel(state);
	state.activeRun = undefined;
	renderWidget(state, ctx);
}

async function handleSharedManagement(
	raw: string,
	pi: ExtensionAPI,
	state: RuntimeState,
	ctx: ExtensionCommandContext,
	kind: "council" | "arena",
): Promise<boolean> {
	if (raw === "help" || raw === "--help" || raw === "-h") {
		ctx.ui.notify(usageText(), "info");
		return true;
	}
	if (raw === "setup") {
		if (!ensureNoActiveRun(state, ctx)) return true;
		await setupRegistry(ctx);
		return true;
	}
	if (raw === "config") {
		ctx.ui.notify(configSummary(readConfig()), "info");
		return true;
	}
	if (raw === "cancel") {
		await cancelActive(pi, state, ctx);
		return true;
	}
	if (raw === "status") {
		if (!state.activeRun) ctx.ui.notify("No Council/Arena run is loaded.", "info");
		else {
			renderWidget(state, ctx);
			ctx.ui.notify(`${runLabel(state.activeRun)} • phase=${state.activeRun.phase}`, "info");
		}
		return true;
	}
	if (raw === "history" || raw.startsWith("history ")) {
		const id = raw.slice("history".length).trim();
		ctx.ui.notify(historyText(kind, id || undefined), "info");
		return true;
	}
	if (raw === "clear") {
		clearCompletedRun(state, ctx);
		return true;
	}
	return false;
}

function refuseChildSession(ctx: ExtensionCommandContext): boolean {
	if (isOwnChildSession(ctx.sessionManager.getSessionName(), ctx.sessionManager.getSessionFile())) {
		ctx.ui.notify("Council/Arena cannot run inside a Council/Arena child session.", "warning");
		return true;
	}
	return false;
}

export default function councilExtension(pi: ExtensionAPI): void {
	const z = pi.zod;
	const states = new Map<string, RuntimeState>();

	function stateFor(ctx: ExtensionContext | ExtensionCommandContext): RuntimeState {
		const key = sessionKeyOf(ctx);
		const existing = states.get(key);
		if (existing) return existing;
		const created = createRuntimeState(key);
		states.set(key, created);
		return created;
	}

	pi.setLabel("Shadow Council");
	pi.registerMessageRenderer(KICKOFF_TYPE, kickoffRenderer);
	pi.registerMessageRenderer("session-stop-continuation", (message) => {
		const text = typeof message.content === "string" ? message.content : "";
		if (!isChairPlumbing(text)) return undefined;
		return new Text("");
	});

	pi.registerTool({
		name: "council_progress",
		label: "Council Progress",
		description: "Internal progress callback for the Shadow Council / Shadow Arena orchestrator.",
		hidden: true,
		loadMode: "essential",
		approval: "read",
		parameters: z.object({
			runId: z.string(),
			phase: z.string(),
			member: z.string().optional(),
			status: z.string().optional(),
			message: z.string().optional(),
			cost: z.number().optional(),
			durationMs: z.number().optional(),
			model: z.string().optional(),
		}),
		renderCall: () => new Text(""),
		renderResult: () => new Text(""),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const progress = params as {
				runId: string;
				phase: string;
				member?: string;
				status?: string;
				message?: string;
				cost?: number;
				durationMs?: number;
				model?: string;
			};
			const state = stateFor(ctx);
			if (!state.activeRun || progress.runId !== state.activeRun.id) {
				return { content: [{ type: "text", text: "stale run" }], details: { stale: true } };
			}
			applyProgress(state.activeRun, progress);
			renderWidget(state, ctx);
			return { content: [{ type: "text", text: "ok" }], details: { runId: progress.runId, phase: progress.phase } };
		},
	});

	pi.registerCommand("council", {
		description: "Shadow Council — structured adversarial review across any authenticated OMP models",
		getArgumentCompletions: (prefix) => argumentCompletions("council", prefix),
		handler: async (args, ctx) => {
			if (refuseChildSession(ctx)) return;
			const state = stateFor(ctx);
			const raw = args.trim();
			try {
				if (await handleSharedManagement(raw, pi, state, ctx, "council")) return;
				const syntax = parseCouncilSyntax(raw);
				const request = await buildCouncilRequest(ctx, syntax, raw.length === 0);
				if (!request) return;
				await startCouncil(pi, state, request, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("arena", {
		description: "Shadow Arena — isolated competing implementations with a blind judge",
		getArgumentCompletions: (prefix) => argumentCompletions("arena", prefix),
		handler: async (args, ctx) => {
			if (refuseChildSession(ctx)) return;
			const state = stateFor(ctx);
			const raw = args.trim();
			try {
				if (raw === "apply") {
					await applyArenaWinner(pi, state, ctx);
					return;
				}
				if (await handleSharedManagement(raw, pi, state, ctx, "arena")) return;
				const syntax = parseArenaSyntax(raw);
				const request = await buildArenaRequest(ctx, syntax, raw.length === 0);
				if (!request) return;
				await startArena(pi, state, request, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		const state = stateFor(ctx);
		if (!state.activeRun || !state.activeRun.awaitingEval || state.activeRun.cancelRequested) return;
		if (isTerminalPhase(state.activeRun.phase)) return;
		return { systemPrompt: applyChairSystemPrompt(event.systemPrompt, state.activeRun) };
	});

	pi.on("tool_call", async (event, ctx) => {
		const state = stateFor(ctx);
		if (!state.activeRun || isTerminalPhase(state.activeRun.phase)) return undefined;
		if (state.activeRun.cancelRequested) return { block: true, reason: `${state.activeRun.id} has been cancelled.` };

		if (event.toolName === "task") {
			return {
				block: true,
				reason: `${state.activeRun.id} is extension-orchestrated. Use the single eval call requested by Council/Arena instead of task.`,
			};
		}

		if (event.toolName === "eval") {
			if (state.activeRun.awaitingEval) {
				state.activeRun.awaitingEval = false;
				state.activeRun.evalToolCallId = event.toolCallId;
				state.activeRun.phase = "starting";
				state.activeRun.statusMessage = "orchestration started";
				renderWidget(state, ctx);
				return { input: evalInputFor(state.activeRun) };
			}
			return {
				block: true,
				reason: `${state.activeRun.id} already owns the active orchestration eval. Synthesize its result instead of starting another eval.`,
			};
		}
		return undefined;
	});
	pi.on("tool_result", async (event, ctx) => {
		const state = stateFor(ctx);
		if (!state.activeRun || event.toolName !== "eval") return undefined;
		if (state.activeRun.evalToolCallId && event.toolCallId !== state.activeRun.evalToolCallId) return undefined;
		if (state.activeRun.cancelRequested) return undefined;

		hydrateUsageFromEval(state.activeRun, event.details);

		if (event.isError) {
			state.activeRun.phase = "failed";
			markMembers(state.activeRun, ["running", "queued"], "failed");
			scrubRun(state, state.activeRun, sessionFileOf(ctx));
			archiveRun(pi, state, state.activeRun);
			detachRunCancel(state);
			renderWidget(state, ctx);
			return undefined;
		}

		const final = findFinalJson(event.details, state.activeRun.kind, state.activeRun.id) ?? readEvalResult(state.activeRun);

		if (!final) {
			state.activeRun.phase = "failed";
			state.activeRun.statusMessage = "orchestration returned no structured result";
			scrubRun(state, state.activeRun, sessionFileOf(ctx));
			archiveRun(pi, state, state.activeRun);
			detachRunCancel(state);
			renderWidget(state, ctx);
			ctx.ui.notify(`${state.activeRun.id} eval completed without the expected structured result.`, "error");
			return undefined;
		}
		state.activeRun.final = final;
		applyOrchestrationResult(state.activeRun, final);
		scrubRun(state, state.activeRun, sessionFileOf(ctx));
		state.activeRun.phase = "synthesizing";
		state.activeRun.statusMessage = "evidence ready; chair synthesizing";
		renderWidget(state, ctx);
		return undefined;
	});

	pi.on("session_stop", async (event, ctx) => {
		const state = stateFor(ctx);
		if (!state.activeRun || isTerminalPhase(state.activeRun.phase) || state.activeRun.cancelRequested) return undefined;
		if (state.activeRun.awaitingEval && !event.stop_hook_active) {
			return {
				continue: true,
				additionalContext: sessionStopNudge(state.activeRun),
			};
		}
		return undefined;
	});

	pi.on("turn_end", async (_event, ctx) => {
		const state = stateFor(ctx);
		if (!state.activeRun || state.activeRun.cancelRequested) return;
		if (state.activeRun.phase === "synthesizing") {
			state.activeRun.phase = "done";
			freezeRunClock(state.activeRun);
			archiveRun(pi, state, state.activeRun);
			detachRunCancel(state);
			renderWidget(state, ctx);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const state = stateFor(ctx);
		cleanupRuntimeAgentsByPrefix(state.instanceId);
		cleanupSeatTranscripts(sessionFileOf(ctx));
		const restored = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY || !entry.data || typeof entry.data !== "object") {
				continue;
			}
			restored.push(entry.data as RuntimeState["history"][number]);
		}
		state.history = restored.reverse().slice(0, 20);
		state.sequence = Math.max(state.sequence, ...state.history.map((item) => Number(item.id.replace(/^[A-Z]/, "")) || 0));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const key = sessionKeyOf(ctx);
		const state = states.get(key);
		if (!state) return;
		if (state.activeRun && !isTerminalPhase(state.activeRun.phase)) {
			state.activeRun.cancelRequested = true;
			state.activeRun.phase = "cancelled";
			ctx.abort();
			scrubRun(state, state.activeRun, sessionFileOf(ctx));
			archiveRun(pi, state, state.activeRun);
		}
		detachRunCancel(state);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		states.delete(key);
	});
}

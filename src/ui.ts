import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAskDialogQuestion, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { readConfig, writeConfig } from "./config.ts";
import { currentModelSelector, exactSelector, listModels, modelChoiceLabel, resolveModel } from "./models.ts";
import { makeParticipantConfig, selectedFromConfig, selectedFromSelector } from "./participants.ts";
import { pickCheckedLabels, pickSingleLabel } from "./picker.ts";
import { MAX_PARTICIPANTS, MIN_PARTICIPANTS } from "./types.ts";
import type { ArenaProfile, CouncilConfig, CouncilMode, ParticipantConfig, RolePreset, SelectedParticipant } from "./types.ts";


export async function pickModelSelectors(
	ctx: ExtensionCommandContext,
	title: string,
	initialSelectors: string[],
): Promise<string[] | undefined> {
	const models = listModels(ctx);
	if (models.length < MIN_PARTICIPANTS) {
		ctx.ui.notify(
			`Only ${models.length} authenticated model(s) are available; Council/Arena needs at least ${MIN_PARTICIPANTS}.`,
			"error",
		);
		return undefined;
	}

	const modelByChoice = new Map<string, string>();
	for (const model of models) modelByChoice.set(modelChoiceLabel(model), `${model.provider}/${model.id}`);
	const initialLabels = models
		.filter((model) => initialSelectors.includes(`${model.provider}/${model.id}`))
		.map((model) => modelChoiceLabel(model));
	const labels = await pickCheckedLabels(
		ctx,
		title,
		models.map((model) => ({
			label: modelChoiceLabel(model),
			description: `${model.provider} • ${model.id}`,
		})),
		initialLabels,
	);
	if (!labels) return undefined;
	return labels.flatMap((label) => {
		const selector = modelByChoice.get(label);
		return selector ? [selector] : [];
	});
}

export async function pickConfiguredParticipants(
	ctx: ExtensionCommandContext,
	config: CouncilConfig,
): Promise<SelectedParticipant[] | undefined> {
	const available = config.participants.filter((participant) => !!resolveModel(ctx, participant.model));
	if (available.length < MIN_PARTICIPANTS) {
		ctx.ui.notify(
			`Only ${available.length} saved Council participant(s) currently resolve. Run /council setup or use /council -t.`,
			"warning",
		);
		return undefined;
	}

	const defaultIds = new Set(config.presets?.default ?? available.map((p) => p.id));
	const selected = new Set(available.filter((p) => defaultIds.has(p.id)).map((p) => p.id));
	if (selected.size < MIN_PARTICIPANTS) {
		selected.clear();
		for (const participant of available.slice(0, Math.min(available.length, MAX_PARTICIPANTS))) selected.add(participant.id);
	}

	const options = available.map((participant) => ({
		label: `${participant.label}  [${participant.id}]`,
		description: participant.model,
	}));
	const initialLabels = available
		.filter((participant) => selected.has(participant.id))
		.map((participant) => `${participant.label}  [${participant.id}]`);
	const labels = await pickCheckedLabels(ctx, "Shadow Council", options, initialLabels);
	if (!labels) return undefined;
	const chosen = new Set(labels);
	return available
		.filter((participant) => chosen.has(`${participant.label}  [${participant.id}]`))
		.map((participant) => selectedFromConfig(ctx, participant));
}

export async function pickJudgeModel(
	ctx: ExtensionCommandContext,
	initial?: string,
	title = "Arena blind judge",
): Promise<string | undefined | null> {
	const models = listModels(ctx);
	if (models.length === 0) return null;
	const current = currentModelSelector(ctx);
	const dynamicLabel = `Current session model${current ? `  [${current}]` : ""}`;
	const choices = [
		{ label: dynamicLabel, description: "Dynamic: use whichever model is active when Arena starts" },
		...models.map((model) => ({
			label: modelChoiceLabel(model),
			description: `${model.provider} • ${model.id}`,
		})),
	];
	const choice = await pickSingleLabel(
		ctx,
		title,
		choices,
		initial ? `Saved judge: ${initial}` : "Judge sees Candidate A/B/C only; provider identities stay hidden.",
	);
	if (!choice) return null;
	if (choice === dynamicLabel) return undefined;
	const model = models.find((item) => modelChoiceLabel(item) === choice);
	return model ? `${model.provider}/${model.id}` : null;
}

export async function setupRegistry(ctx: ExtensionCommandContext): Promise<CouncilConfig | undefined> {
	const existing = readConfig();
	const initial =
		existing?.participants.map((p) => exactSelector(ctx, p.model)).filter((value): value is string => !!value) ?? [];
	const selectors = await pickModelSelectors(ctx, "Council setup — saved participants", initial);
	if (!selectors) return undefined;

	const existingByExact = new Map<string, ParticipantConfig>();
	for (const participant of existing?.participants ?? []) {
		const exact = exactSelector(ctx, participant.model);
		if (exact) existingByExact.set(exact, participant);
	}

	const used = new Set<string>();
	const participants = [];
	for (const selector of selectors) {
		const model = resolveModel(ctx, selector);
		if (!model) continue;
		const prior = existingByExact.get(selector);
		if (prior) used.add(prior.id);
		participants.push(makeParticipantConfig(model, used, prior));
	}

	if (participants.length < MIN_PARTICIPANTS) {
		ctx.ui.notify("Not enough selected models resolved while saving Council setup.", "error");
		return undefined;
	}

	const judgeModel = await pickJudgeModel(ctx, existing?.judgeModel, "Council setup — default Arena judge");
	if (judgeModel === null) return undefined;

	const ids = participants.map((p) => p.id);
	const idSet = new Set(ids);
	const presets: Record<string, string[]> = {};
	for (const [name, members] of Object.entries(existing?.presets ?? {})) {
		const kept = members.filter((id) => idSet.has(id));
		if (kept.length >= MIN_PARTICIPANTS) presets[name] = kept;
	}
	presets.default = presets.default?.length ? presets.default : ids;
	presets.all = ids;

	const config: CouncilConfig = {
		version: 1,
		participants,
		presets,
		...(judgeModel ? { judgeModel } : {}),
		...(existing?.shimmer === false ? { shimmer: false } : {}),
	};
	writeConfig(config);
	ctx.ui.notify(`Saved ${participants.length} Council participant(s).`, "info");
	return config;
}

export async function promptCouncilMode(ctx: ExtensionCommandContext): Promise<CouncilMode | undefined> {
	const choice = await ctx.ui.select("Mode", [
		{ label: "Debate", description: "Independent + one anonymized rebuttal" },
		{ label: "Quick", description: "Independent round only" },
		{ label: "Deep", description: "Independent + rebuttal + final reconsideration" },
	], { selectionMarker: "radio" });
	if (!choice) return undefined;
	return choice === "Quick" ? "quick" : choice === "Deep" ? "deep" : "debate";
}

export async function promptRolePreset(ctx: ExtensionCommandContext): Promise<RolePreset | undefined> {
	const choice = await ctx.ui.select("Role", ["General", "Architecture", "Debug", "Security", "Refactor"], {
		selectionMarker: "radio",
	});
	return choice ? (choice.toLowerCase() as RolePreset) : undefined;
}

export async function promptArenaProfile(ctx: ExtensionCommandContext): Promise<ArenaProfile | undefined> {
	const rust = existsSync(join(ctx.cwd, "Cargo.toml"));
	const choice = await ctx.ui.select("Arena verification profile", [
		`Auto${rust ? " (Rust detected)" : ""}`,
		"Rust — fmt/check/clippy/test gates",
		"General — project-appropriate validation",
	], { selectionMarker: "radio" });
	if (!choice) return undefined;
	return choice.startsWith("Rust") ? "rust" : choice.startsWith("General") ? "general" : "auto";
}

export async function promptCouncilForm(
	ctx: ExtensionCommandContext,
	options: {
		participantChoices: Array<{ label: string; description?: string }>;
		initialChecked: number[];
		includeMode: boolean;
		includeRole: boolean;
		title: string;
	},
): Promise<{ selectedLabels: string[]; mode?: CouncilMode; role?: RolePreset } | undefined> {
	if (!ctx.ui.askDialog) return undefined;
	const questions: ExtensionAskDialogQuestion[] = [
		{
			id: "participants",
			question: "Space toggles seats. Enter continues. Pick 2-8.",
			header: options.title,
			options: options.participantChoices,
			multi: true,
		},
	];
	if (options.includeMode) {
		questions.push({
			id: "mode",
			question: "Mode",
			options: [
				{ label: "Quick", description: "One independent round, then a synthesis" },
				{ label: "Debate", description: "Independent round, then they challenge each other" },
				{ label: "Deep", description: "Independent, challenge, then a final review" },
			],
			multi: false,
			recommended: 1,
		});
	}
	if (options.includeRole) {
		questions.push({
			id: "role",
			question: "Role",
			options: [
				{ label: "General" },
				{ label: "Architecture" },
				{ label: "Debug" },
				{ label: "Security" },
				{ label: "Refactor" },
			],
			multi: false,
			recommended: 0,
		});
	}
	const result = await ctx.ui.askDialog(questions);
	if (!result || result.kind !== "submit") return undefined;
	const byId = new Map(result.results.map((item) => [item.id, item]));
	const participants = byId.get("participants")?.selectedOptions ?? [];
	if (participants.length < MIN_PARTICIPANTS) {
		ctx.ui.notify(`Select at least ${MIN_PARTICIPANTS} models.`, "warning");
		return undefined;
	}
	if (participants.length > MAX_PARTICIPANTS) {
		ctx.ui.notify(`Select at most ${MAX_PARTICIPANTS} models.`, "warning");
		return undefined;
	}
	const modeLabel = byId.get("mode")?.selectedOptions[0];
	const roleLabel = byId.get("role")?.selectedOptions[0];
	return {
		selectedLabels: participants,
		mode: modeLabel ? (modeLabel.toLowerCase() as CouncilMode) : undefined,
		role: roleLabel ? (roleLabel.toLowerCase() as RolePreset) : undefined,
	};
}

export function selectorsToParticipants(
	ctx: ExtensionCommandContext,
	selectors: string[],
	temporary: boolean,
): SelectedParticipant[] {
	return selectors.map((selector) => selectedFromSelector(ctx, selector, temporary));
}

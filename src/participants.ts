import type { ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { slug, unique } from "./config.ts";
import { exactSelector, labelForModel, resolveModel, selectorForModel } from "./models.ts";
import { MAX_PARTICIPANTS, MIN_PARTICIPANTS } from "./types.ts";
import type { CouncilConfig, ModelLike, ParticipantConfig, SelectedParticipant } from "./types.ts";

export function participantIdFor(model: ModelLike, used: Set<string>): string {
	const candidates = [slug(labelForModel(model)), slug(model.id), slug(`${model.provider}-${model.id}`)];
	for (const candidate of candidates) {
		if (!used.has(candidate)) {
			used.add(candidate);
			return candidate;
		}
	}
	let n = 2;
	const base = slug(`${model.provider}-${model.id}`);
	while (used.has(`${base}-${n}`)) n += 1;
	const id = `${base}-${n}`;
	used.add(id);
	return id;
}

export function makeParticipantConfig(
	model: ModelLike,
	used: Set<string>,
	existing?: ParticipantConfig,
): ParticipantConfig {
	if (existing) return existing;
	const label = labelForModel(model);
	const id = participantIdFor(model, used);
	const aliases = unique([slug(model.id), slug(label)]).filter((alias) => alias !== id);
	return {
		id,
		label,
		model: selectorForModel(model),
		aliases,
		tags: [],
	};
}

export function selectedFromConfig(
	ctx: ExtensionContext | ExtensionCommandContext,
	participant: ParticipantConfig,
): SelectedParticipant {
	const resolved = resolveModel(ctx, participant.model);
	if (!resolved) throw new Error(`Saved participant ${participant.id} no longer resolves: ${participant.model}`);
	return {
		registryId: participant.id,
		label: participant.label,
		model: participant.model,
		provider: resolved.provider,
		temporary: false,
	};
}

export function selectedFromSelector(
	ctx: ExtensionContext | ExtensionCommandContext,
	spec: string,
	temporary: boolean,
): SelectedParticipant {
	const resolved = resolveModel(ctx, spec);
	if (!resolved) throw new Error(`Model does not resolve or is not authenticated: ${spec}`);
	return {
		label: labelForModel(resolved),
		model: selectorForModel(resolved),
		provider: resolved.provider,
		temporary,
	};
}

export function resolveParticipantTokens(
	ctx: ExtensionCommandContext,
	config: CouncilConfig | undefined,
	tokens: string[],
): SelectedParticipant[] {
	if (tokens.length === 0) {
		if (!config) throw new Error("No saved Council registry. Run /council setup, /council, or use -t/--tmp.");
		const ids = config.presets?.default ?? config.participants.map((p) => p.id);
		return ids.map((id) => {
			const participant = config.participants.find((p) => p.id === id);
			if (!participant) throw new Error(`Preset default references missing participant: ${id}`);
			return selectedFromConfig(ctx, participant);
		});
	}

	const expanded: SelectedParticipant[] = [];
	const byId = new Map((config?.participants ?? []).map((p) => [p.id.toLowerCase(), p]));
	const presets = new Map(Object.entries(config?.presets ?? {}).map(([name, ids]) => [name.toLowerCase(), ids]));

	const addConfigId = (id: string) => {
		const participant = config?.participants.find((p) => p.id === id);
		if (!participant) throw new Error(`Preset references missing participant: ${id}`);
		expanded.push(selectedFromConfig(ctx, participant));
	};

	for (const rawToken of tokens) {
		for (const piece of rawToken.split(/[,+]/).map((value) => value.trim()).filter(Boolean)) {
			const token = piece.toLowerCase();
			if (token === "all") {
				if (!config) throw new Error("'all' needs a saved registry. Run /council setup or use -t/--tmp.");
				for (const participant of config.participants) expanded.push(selectedFromConfig(ctx, participant));
				continue;
			}
			const preset = presets.get(token);
			if (preset) {
				for (const id of preset) addConfigId(id);
				continue;
			}
			if (token.startsWith("tag:")) {
				if (!config) throw new Error(`Tag selector ${piece} needs a saved registry.`);
				const tag = token.slice(4);
				const matches = config.participants.filter((p) =>
					(p.tags ?? []).some((value) => value.toLowerCase() === tag),
				);
				if (matches.length === 0) throw new Error(`No saved participants have tag: ${tag}`);
				for (const participant of matches) expanded.push(selectedFromConfig(ctx, participant));
				continue;
			}
			const configured =
				byId.get(token) ??
				config?.participants.find(
					(p) =>
						p.label.toLowerCase() === token ||
						(p.aliases ?? []).some((alias) => alias.toLowerCase() === token),
				);
			if (configured) {
				expanded.push(selectedFromConfig(ctx, configured));
				continue;
			}
			expanded.push(selectedFromSelector(ctx, piece, true));
		}
	}

	const deduped: SelectedParticipant[] = [];
	const seen = new Set<string>();
	for (const participant of expanded) {
		const key = participant.model.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(participant);
	}
	if (deduped.length < MIN_PARTICIPANTS) {
		throw new Error(`Council/Arena requires at least ${MIN_PARTICIPANTS} distinct models.`);
	}
	if (deduped.length > MAX_PARTICIPANTS) {
		throw new Error(`Council/Arena supports at most ${MAX_PARTICIPANTS} models per run.`);
	}
	return deduped;
}

export function preselectedFromTokens(ctx: ExtensionCommandContext, tokens: string[]): string[] {
	const selectors: string[] = [];
	for (const raw of tokens) {
		for (const token of raw.split(/[,+]/).map((value) => value.trim()).filter(Boolean)) {
			const exact = exactSelector(ctx, token);
			if (exact) selectors.push(exact);
		}
	}
	return unique(selectors);
}

function tokenIsSelector(
	ctx: ExtensionCommandContext | ExtensionContext,
	config: CouncilConfig | undefined,
	raw: string,
): boolean {
	const token = raw.toLowerCase();
	if (token === "all" || token.startsWith("tag:")) return true;
	if (config?.presets && Object.keys(config.presets).some((name) => name.toLowerCase() === token)) return true;
	if (
		config?.participants.some(
			(participant) =>
				participant.id.toLowerCase() === token ||
				participant.label.toLowerCase() === token ||
				(participant.aliases ?? []).some((alias) => alias.toLowerCase() === token),
		)
	) {
		return true;
	}
	return !!resolveModel(ctx, raw);
}

export function splitBarePrompt(
	ctx: ExtensionCommandContext | ExtensionContext,
	config: CouncilConfig | undefined,
	tokens: string[],
): { participantTokens: string[]; question?: string } {
	let splitAt = tokens.length;
	for (let i = 0; i < tokens.length; i += 1) {
		if (!tokenIsSelector(ctx, config, tokens[i] ?? "")) {
			splitAt = i;
			break;
		}
	}
	const participantTokens = tokens.slice(0, splitAt);
	const question = tokens.slice(splitAt).join(" ").trim();
	return question ? { participantTokens, question } : { participantTokens };
}

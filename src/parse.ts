import {
	ARENA_PROFILES,
	type ArenaProfile,
	type ArenaSyntax,
	type CouncilMode,
	type CouncilSyntax,
	ROLE_PRESETS,
	type RolePreset,
} from "./types.ts";

export function splitOptionalPayload(raw: string): { left: string; question?: string } {
	const match = /(?:^|\s)--(?=\s|$)/.exec(raw);
	if (!match || match.index === undefined) return { left: raw.trim() };
	const delimiterIndex = match.index + (match[0].startsWith(" ") ? 1 : 0);
	const left = raw.slice(0, delimiterIndex).trim();
	const question = raw.slice(delimiterIndex + 2).trim();
	if (!question) throw new Error("Prompt cannot be empty after '--'.");
	return { left, question };
}

function isRolePreset(value: string): value is RolePreset {
	return (ROLE_PRESETS as readonly string[]).includes(value);
}

function isArenaProfile(value: string): value is ArenaProfile {
	return (ARENA_PROFILES as readonly string[]).includes(value);
}

export function parseCouncilSyntax(raw: string): CouncilSyntax {
	const { left, question } = splitOptionalPayload(raw);
	const tokens = left ? left.split(/\s+/) : [];
	let temporary = false;
	let mode: CouncilMode = "debate";
	let modeSpecified = false;
	let rolePreset: RolePreset = "general";
	let roleSpecified = false;
	const participantTokens: string[] = [];

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i].toLowerCase();
		if (token === "-t" || token === "--tmp") {
			temporary = true;
			continue;
		}
		if (token === "--quick" || token === "--debate" || token === "--deep") {
			mode = token.slice(2) as CouncilMode;
			modeSpecified = true;
			continue;
		}
		if (token === "--role") {
			const value = (tokens[++i] ?? "").toLowerCase();
			if (!isRolePreset(value)) throw new Error(`Unknown role preset: ${value}`);
			rolePreset = value;
			roleSpecified = true;
			continue;
		}
		if (token.startsWith("--role=")) {
			const value = token.slice("--role=".length);
			if (!isRolePreset(value)) throw new Error(`Unknown role preset: ${value}`);
			rolePreset = value;
			roleSpecified = true;
			continue;
		}
		participantTokens.push(tokens[i]);
	}

	return { temporary, participantTokens, mode, modeSpecified, rolePreset, roleSpecified, question };
}

export function parseArenaSyntax(raw: string): ArenaSyntax {
	const { left, question } = splitOptionalPayload(raw);
	const tokens = left ? left.split(/\s+/) : [];
	let temporary = false;
	let arenaProfile: ArenaProfile = "auto";
	let profileSpecified = false;
	let judgeToken: string | undefined;
	const participantTokens: string[] = [];

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i].toLowerCase();
		if (token === "-t" || token === "--tmp") {
			temporary = true;
			continue;
		}
		if (token === "--profile") {
			const value = (tokens[++i] ?? "").toLowerCase();
			if (!isArenaProfile(value)) throw new Error(`Unknown Arena profile: ${value}`);
			arenaProfile = value;
			profileSpecified = true;
			continue;
		}
		if (token.startsWith("--profile=")) {
			const value = token.slice("--profile=".length);
			if (!isArenaProfile(value)) throw new Error(`Unknown Arena profile: ${value}`);
			arenaProfile = value;
			profileSpecified = true;
			continue;
		}
		if (token === "--judge") {
			judgeToken = tokens[++i];
			if (!judgeToken) throw new Error("--judge requires a model selector or role alias.");
			continue;
		}
		if (token.startsWith("--judge=")) {
			judgeToken = tokens[i].slice("--judge=".length);
			if (!judgeToken) throw new Error("--judge requires a model selector or role alias.");
			continue;
		}
		participantTokens.push(tokens[i]);
	}

	return { temporary, participantTokens, arenaProfile, profileSpecified, judgeToken, question };
}

export function parseHistoryArgs(raw: string): { id?: string } {
	const rest = raw.replace(/^history\b/i, "").trim();
	const id = rest.split(/\s+/).filter(Boolean)[0];
	return { id };
}



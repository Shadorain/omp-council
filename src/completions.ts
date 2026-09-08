import { ARENA_PROFILES, ROLE_PRESETS } from "./types.ts";

export interface ArgumentCompletion {
	value: string;
	label: string;
	description: string;
	hint?: string;
}

interface FlagOption {
	value: string;
	aliases?: string[];
	description: string;
	hint: string;
	takesValue?: "role" | "profile" | "judge";
	group?: "tmp" | "mode" | "role" | "profile" | "judge";
}

const COUNCIL_FLAGS: FlagOption[] = [
	{
		value: "-t",
		aliases: ["--tmp"],
		description: "Pick models for this run only; do not save",
		hint: " [question]",
		group: "tmp",
	},
	{ value: "--quick", description: "Independent round only", hint: " [question]", group: "mode" },
	{ value: "--debate", description: "Independent plus one rebuttal", hint: " [question]", group: "mode" },
	{ value: "--deep", description: "Independent plus two challenge rounds", hint: " [question]", group: "mode" },
	{
		value: "--role",
		description: "Cognitive lens independent of the model",
		hint: " <preset> [question]",
		takesValue: "role",
		group: "role",
	},
];

const ARENA_FLAGS: FlagOption[] = [
	{
		value: "-t",
		aliases: ["--tmp"],
		description: "Pick candidates for this run only; do not save",
		hint: " [task]",
		group: "tmp",
	},
	{
		value: "--profile",
		description: "Verification profile",
		hint: " <profile> [task]",
		takesValue: "profile",
		group: "profile",
	},
	{
		value: "--judge",
		description: "Blind judge model or @role",
		hint: " <model-or-role> [task]",
		takesValue: "judge",
		group: "judge",
	},
];

const COUNCIL_LIFECYCLE: ArgumentCompletion[] = [
	{ value: "status", label: "status", description: "Show the active run" },
	{ value: "cancel", label: "cancel", description: "Abort the active run and child agents" },
	{ value: "history", label: "history", description: "Last 20 runs; pass an id like C14 to open one" },
	{ value: "clear", label: "clear", description: "Dismiss a finished run widget" },
	{ value: "setup", label: "setup", description: "Rebuild the saved participant registry" },
	{ value: "config", label: "config", description: "Print the saved registry path and seats" },
	{ value: "help", label: "help", description: "Show usage" },
];

const ARENA_LIFECYCLE: ArgumentCompletion[] = [
	{ value: "apply", label: "apply", description: "Check and apply the judged winner after confirm" },
	...COUNCIL_LIFECYCLE,
];

function splitArgs(argumentText: string): { complete: string[]; partial: string } {
	const endsWithSpace = /\s$/.test(argumentText);
	const parts = argumentText.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { complete: [], partial: "" };
	if (endsWithSpace) return { complete: parts, partial: "" };
	return { complete: parts.slice(0, -1), partial: parts[parts.length - 1] ?? "" };
}

function hasPromptDelimiter(argumentText: string): boolean {
	return /(?:^|\s)--(?=\s|$)/.test(argumentText);
}

function joinValue(complete: string[], token: string): string {
	return complete.length > 0 ? `${complete.join(" ")} ${token}` : token;
}

function namesOf(flag: FlagOption): string[] {
	return [flag.value, ...(flag.aliases ?? [])];
}

function matchingName(flag: FlagOption, prefix: string): string | undefined {
	if (prefix.length === 0) return flag.value;
	return namesOf(flag).find((name) => name.startsWith(prefix));
}

function usedGroups(tokens: string[], flags: FlagOption[]): Set<string> {
	const used = new Set<string>();
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i].toLowerCase();
		for (const flag of flags) {
			if (namesOf(flag).includes(token) || (flag.takesValue && token.startsWith(`${flag.value}=`))) {
				if (flag.group) used.add(flag.group);
			}
		}
	}
	return used;
}

function isLifecycle(token: string, lifecycle: ArgumentCompletion[]): boolean {
	return lifecycle.some((item) => item.value === token);
}

function roleItems(complete: string[], prefix: string, equals: boolean): ArgumentCompletion[] {
	return ROLE_PRESETS.filter((role) => prefix.length === 0 || role.startsWith(prefix)).map((role) => ({
		value: equals ? joinValue(complete, `--role=${role}`) : joinValue(complete, role),
		label: role,
		description: `Lens preset ${role}`,
		hint: " [question]",
	}));
}

function profileItems(complete: string[], prefix: string, equals: boolean): ArgumentCompletion[] {
	return ARENA_PROFILES.filter((profile) => prefix.length === 0 || profile.startsWith(prefix)).map((profile) => ({
		value: equals ? joinValue(complete, `--profile=${profile}`) : joinValue(complete, profile),
		label: profile,
		description: profile === "auto" ? "Rust if Cargo.toml exists, otherwise general" : `Use the ${profile} verification gates`,
		hint: " [task]",
	}));
}

function completeValueFlag(
	complete: string[],
	partial: string,
	flag: FlagOption,
): ArgumentCompletion[] | undefined {
	const last = complete[complete.length - 1];
	if (flag.takesValue === "role") {
		if (last === "--role") return roleItems(complete, partial, false);
		if (partial.startsWith("--role=")) return roleItems(complete, partial.slice("--role=".length), true);
	}
	if (flag.takesValue === "profile") {
		if (last === "--profile") return profileItems(complete, partial, false);
		if (partial.startsWith("--profile=")) return profileItems(complete, partial.slice("--profile=".length), true);
	}
	if (flag.takesValue === "judge" && last === "--judge") {
		if (partial.startsWith("-")) return undefined;
		return [
			{
				value: joinValue(complete, partial),
				label: "[model-or-role]",
				description: "Judge selector; identities stay hidden from candidates",
				hint: " [task]",
			},
		];
	}
	return undefined;
}

function flagItems(
	complete: string[],
	partial: string,
	flags: FlagOption[],
	placeholder: string,
): ArgumentCompletion[] {
	const used = usedGroups(complete, flags);
	const items: ArgumentCompletion[] = [];
	for (const flag of flags) {
		if (flag.group && used.has(flag.group)) continue;
		const insert = matchingName(flag, partial);
		if (!insert) continue;
		items.push({
			value: joinValue(complete, insert),
			label: insert,
			description: flag.description,
			hint: flag.hint.replace("[question]", placeholder).replace("[task]", placeholder),
		});
	}
	return items;
}

function lifecycleItems(partial: string, lifecycle: ArgumentCompletion[]): ArgumentCompletion[] {
	return lifecycle.filter((item) => partial.length === 0 || item.value.startsWith(partial));
}

function completeArgs(
	argumentText: string,
	flags: FlagOption[],
	lifecycle: ArgumentCompletion[],
	placeholder: { label: string; description: string; hint: string },
): ArgumentCompletion[] {
	if (hasPromptDelimiter(argumentText)) return [];
	const { complete, partial } = splitArgs(argumentText);
	if (complete[0] && isLifecycle(complete[0], lifecycle)) return [];

	for (const flag of flags) {
		const valued = completeValueFlag(complete, partial, flag);
		if (valued) return valued;
	}

	const completingFlags = partial.startsWith("-");
	const items: ArgumentCompletion[] = [];
	if (!completingFlags && complete.length === 0) {
		if (partial.length === 0) {
			items.push({
				value: "",
				label: placeholder.label,
				description: placeholder.description,
				hint: placeholder.hint,
			});
		}
		items.push(...lifecycleItems(partial, lifecycle));
	}

	if (complete.length > 0 && !completingFlags && partial.length === 0) {
		items.push({
			value: joinValue(complete, "").trimEnd() + " ",
			label: placeholder.label,
			description: placeholder.description,
			hint: placeholder.hint,
		});
	}

	items.push(...flagItems(complete, partial, flags, placeholder.hint.trim()));
	return items;
}

export function councilArgumentCompletions(argumentText: string): ArgumentCompletion[] {
	return completeArgs(argumentText, COUNCIL_FLAGS, COUNCIL_LIFECYCLE, {
		label: "[question]",
		description: "Optional. Empty opens the Council UI",
		hint: "[question]",
	});
}

export function arenaArgumentCompletions(argumentText: string): ArgumentCompletion[] {
	return completeArgs(argumentText, ARENA_FLAGS, ARENA_LIFECYCLE, {
		label: "[task]",
		description: "Optional. Empty opens the Arena UI",
		hint: "[task]",
	});
}

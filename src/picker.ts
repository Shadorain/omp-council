import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@oh-my-pi/pi-coding-agent";
import { MAX_PARTICIPANTS, MIN_PARTICIPANTS } from "./types.ts";

export interface PickOption {
	label: string;
	description?: string;
}

export function optionsMatchingQuery(options: PickOption[], query: string): PickOption[] {
	const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return options;
	return options.filter((option) => {
		const hay = `${option.label} ${option.description ?? ""}`.toLowerCase();
		return tokens.every((token) => hay.includes(token));
	});
}

function isEnter(data: string, keybindings: KeybindingsManager): boolean {
	return keybindings.matches(data, "tui.select.confirm") || data === "\n" || data === "\r";
}

function isSpace(data: string): boolean {
	return data === " " || data === "space";
}

function isBackspace(data: string, keybindings: KeybindingsManager): boolean {
	return keybindings.matches(data, "tui.select.cancel")
		? false
		: data === "\x7f" || data === "\b" || data === "backspace";
}

function printableChar(data: string): string | undefined {
	if (data.length !== 1) return undefined;
	if (data === " " || data < " " || data > "~") return undefined;
	return data;
}

export async function pickCheckedLabels(
	ctx: ExtensionCommandContext,
	title: string,
	options: PickOption[],
	initialLabels: string[],
): Promise<string[] | undefined> {
	const allowed = new Set(options.map((option) => option.label));
	if (typeof ctx.ui.custom === "function") {
		const picked = await ctx.ui.custom<string[] | undefined>((_tui, theme, keybindings, done) =>
			multiPickComponent(title, options, initialLabels, theme, keybindings, ctx, done),
		);
		if (!picked) return undefined;
		return picked.filter((label) => allowed.has(label));
	}

	if (ctx.ui.askDialog) {
		while (true) {
			const result = await ctx.ui.askDialog([
				{
					id: "pick",
					header: title,
					question: `Space toggles. Enter submits. Type to filter. Pick ${MIN_PARTICIPANTS}-${MAX_PARTICIPANTS} models.`,
					options,
					multi: true,
				},
			]);
			if (!result || result.kind !== "submit") return undefined;
			const labels = (result.results.find((item) => item.id === "pick")?.selectedOptions ?? []).filter((label) =>
				allowed.has(label),
			);
			if (labels.length < MIN_PARTICIPANTS) {
				ctx.ui.notify(`Select at least ${MIN_PARTICIPANTS} models.`, "warning");
				continue;
			}
			if (labels.length > MAX_PARTICIPANTS) {
				ctx.ui.notify(`Select at most ${MAX_PARTICIPANTS} models.`, "warning");
				continue;
			}
			return labels;
		}
	}

	const selected = new Set(initialLabels.filter((label) => allowed.has(label)));
	while (true) {
		const choices = [
			...options,
			{ label: `Start (${selected.size} selected)`, description: `Launch with these models; max ${MAX_PARTICIPANTS}` },
			{ label: "Cancel", description: "Close without starting" },
		];
		const checkedIndices = options.flatMap((option, index) => (selected.has(option.label) ? [index] : []));
		const choice = await ctx.ui.select(title, choices, {
			selectionMarker: "checkbox",
			checkedIndices,
			markableCount: options.length,
			helpText: "Type to filter. Enter toggles. Choose Start to submit.",
		});
		if (!choice || choice === "Cancel") return undefined;
		if (choice.startsWith("Start (")) {
			if (selected.size < MIN_PARTICIPANTS) {
				ctx.ui.notify(`Select at least ${MIN_PARTICIPANTS} models.`, "warning");
				continue;
			}
			if (selected.size > MAX_PARTICIPANTS) {
				ctx.ui.notify(`Select at most ${MAX_PARTICIPANTS} models.`, "warning");
				continue;
			}
			return [...selected];
		}
		if (!allowed.has(choice)) continue;
		if (selected.has(choice)) selected.delete(choice);
		else {
			if (selected.size >= MAX_PARTICIPANTS) {
				ctx.ui.notify(`Council/Arena is capped at ${MAX_PARTICIPANTS} participants per run.`, "warning");
				continue;
			}
			selected.add(choice);
		}
	}
}

export async function pickSingleLabel(
	ctx: ExtensionCommandContext,
	title: string,
	options: PickOption[],
	helpText: string,
): Promise<string | undefined> {
	if (typeof ctx.ui.custom === "function") {
		return ctx.ui.custom<string | undefined>((_tui, theme, keybindings, done) =>
			singlePickComponent(title, options, helpText, theme, keybindings, done),
		);
	}
	const choice = await ctx.ui.select(title, options, { helpText });
	return choice;
}

export function paint(theme: Theme, color: string, text: string): string {
	if (typeof theme.fg !== "function") return text;
	return theme.fg(color as "accent" | "dim" | "muted" | "success" | "error", text);
}

function multiPickComponent(
	title: string,
	options: PickOption[],
	initialLabels: string[],
	theme: Theme,
	keybindings: KeybindingsManager,
	ctx: ExtensionCommandContext,
	done: (result: string[] | undefined) => void,
) {
	const selected = new Set(initialLabels);
	let query = "";
	let cursor = 0;

	const visible = () => optionsMatchingQuery(options, query);

	const clampCursor = () => {
		const rows = visible();
		if (rows.length === 0) {
			cursor = 0;
			return;
		}
		if (cursor >= rows.length) cursor = rows.length - 1;
		if (cursor < 0) cursor = 0;
	};

	return {
		render(width: number): readonly string[] {
			clampCursor();
			const rows = visible();
			const lines = [
				paint(theme, "accent", title),
				paint(theme, "dim", "Type to filter. Space toggles. Enter submits. Esc cancels."),
			];
			if (query) lines.push(paint(theme, "accent", `Filter: ${query}`));
			lines.push("");
			const budget = Math.max(6, Math.min(14, rows.length));
			const start = Math.max(0, Math.min(cursor - Math.floor(budget / 2), Math.max(0, rows.length - budget)));
			const slice = rows.slice(start, start + budget);
			for (let i = 0; i < slice.length; i += 1) {
				const option = slice[i];
				if (!option) continue;
				const index = start + i;
				const mark = selected.has(option.label) ? "[x]" : "[ ]";
				const prefix = index === cursor ? "> " : "  ";
				const desc = option.description ? `  ${option.description}` : "";
				const line = `${prefix}${mark} ${option.label}${desc}`;
				lines.push(index === cursor ? paint(theme, "accent", line.slice(0, Math.max(1, width))) : line.slice(0, Math.max(1, width)));
			}
			if (rows.length === 0) lines.push(paint(theme, "dim", "  No matches"));
			lines.push("");
			lines.push(paint(theme, "dim", `${selected.size} selected  (${MIN_PARTICIPANTS}-${MAX_PARTICIPANTS})`));
			return lines;
		},
		invalidate() {},
		handleInput(data: string) {
			if (keybindings.matches(data, "tui.select.cancel")) {
				done(undefined);
				return;
			}
			if (keybindings.matches(data, "tui.select.up") || data === "k") {
				cursor -= 1;
				clampCursor();
				return;
			}
			if (keybindings.matches(data, "tui.select.down") || data === "j") {
				cursor += 1;
				clampCursor();
				return;
			}
			if (isSpace(data)) {
				const option = visible()[cursor];
				if (!option) return;
				if (selected.has(option.label)) selected.delete(option.label);
				else {
					if (selected.size >= MAX_PARTICIPANTS) {
						ctx.ui.notify(`Council/Arena is capped at ${MAX_PARTICIPANTS} participants per run.`, "warning");
						return;
					}
					selected.add(option.label);
				}
				return;
			}
			if (isEnter(data, keybindings)) {
				if (selected.size < MIN_PARTICIPANTS) {
					ctx.ui.notify(`Select at least ${MIN_PARTICIPANTS} models.`, "warning");
					return;
				}
				if (selected.size > MAX_PARTICIPANTS) {
					ctx.ui.notify(`Select at most ${MAX_PARTICIPANTS} models.`, "warning");
					return;
				}
				done([...selected]);
				return;
			}
			if (isBackspace(data, keybindings)) {
				query = query.slice(0, -1);
				cursor = 0;
				return;
			}
			const ch = printableChar(data);
			if (ch) {
				query += ch;
				cursor = 0;
			}
		},
	};
}

function singlePickComponent(
	title: string,
	options: PickOption[],
	helpText: string,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: string | undefined) => void,
) {
	let query = "";
	let cursor = 0;
	const visible = () => optionsMatchingQuery(options, query);
	const clampCursor = () => {
		const rows = visible();
		cursor = rows.length === 0 ? 0 : Math.max(0, Math.min(cursor, rows.length - 1));
	};

	return {
		render(width: number): readonly string[] {
			clampCursor();
			const rows = visible();
			const lines = [
				paint(theme, "accent", title),
				paint(theme, "dim", `Type to filter. Enter selects. Esc cancels. ${helpText}`),
			];
			if (query) lines.push(paint(theme, "accent", `Filter: ${query}`));
			lines.push("");
			const budget = Math.max(6, Math.min(14, rows.length));
			const start = Math.max(0, Math.min(cursor - Math.floor(budget / 2), Math.max(0, rows.length - budget)));
			const slice = rows.slice(start, start + budget);
			for (let i = 0; i < slice.length; i += 1) {
				const option = slice[i];
				if (!option) continue;
				const index = start + i;
				const prefix = index === cursor ? "> " : "  ";
				const desc = option.description ? `  ${option.description}` : "";
				const line = `${prefix}${option.label}${desc}`;
				lines.push(index === cursor ? paint(theme, "accent", line.slice(0, Math.max(1, width))) : line.slice(0, Math.max(1, width)));
			}
			if (rows.length === 0) lines.push(paint(theme, "dim", "  No matches"));
			return lines;
		},
		invalidate() {},
		handleInput(data: string) {
			if (keybindings.matches(data, "tui.select.cancel")) {
				done(undefined);
				return;
			}
			if (keybindings.matches(data, "tui.select.up") || data === "k") {
				cursor -= 1;
				clampCursor();
				return;
			}
			if (keybindings.matches(data, "tui.select.down") || data === "j") {
				cursor += 1;
				clampCursor();
				return;
			}
			if (isEnter(data, keybindings) || isSpace(data)) {
				const option = visible()[cursor];
				if (option) done(option.label);
				return;
			}
			if (isBackspace(data, keybindings)) {
				query = query.slice(0, -1);
				cursor = 0;
				return;
			}
			const ch = printableChar(data);
			if (ch) {
				query += ch;
				cursor = 0;
			}
		},
	};
}

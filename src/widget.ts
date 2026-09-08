import type { ExtensionCommandContext, ExtensionContext, MessageRenderer } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-tui";
import { readConfig } from "./config.ts";
import type { KickoffDetails } from "./orchestration.ts";
import { STATUS_KEY, WIDGET_KEY, isTerminalPhase } from "./types.ts";
import type { ActiveRun, MemberState, MemberStatus, RuntimeState } from "./types.ts";


const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ESC_ICON = "󱊷";
const SHIMMER_RGB: ReadonlyArray<readonly [number, number, number]> = [
	[96, 64, 196],
	[132, 82, 232],
	[158, 108, 255],
	[88, 128, 238],
	[64, 156, 246],
	[78, 92, 214],
];
const SHIMMER_MS = 420;

export type WidgetPaint = (tone: string, text: string) => string;

export interface WidgetRenderOptions {
	shimmer?: boolean;
	paint?: WidgetPaint;
	width?: number;
}

export function isCouncilCancel(data: string): boolean {
	if (data === "\x1b" || data === "\x03") return true;
	if (data === "escape" || data === "esc" || data === "ctrl+c") return true;
	if (data.startsWith("\x1b[27") && data.endsWith("u")) return true;
	if (data.startsWith("\x1b[99;") && data.includes(";5") && data.endsWith("u")) return true;
	return false;
}

export function widgetShimmerEnabled(): boolean {
	const env = process.env.OMP_COUNCIL_SHIMMER?.trim().toLowerCase();
	if (env === "0" || env === "false" || env === "off") return false;
	if (env === "1" || env === "true" || env === "on") return true;
	return readConfig()?.shimmer !== false;
}

function short(value: string, max = 22): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
}

function paint(options: WidgetRenderOptions | undefined, tone: string, text: string): string {
	return options?.paint ? options.paint(tone, text) : text;
}

function wave(text: string, now: number): string {
	const sweep = Math.floor(now / SHIMMER_MS);
	let out = "";
	for (let i = 0; i < text.length; i += 1) {
		const [r, g, b] = SHIMMER_RGB[(i + sweep) % SHIMMER_RGB.length] ?? SHIMMER_RGB[0];
		out += `\x1b[38;2;${r};${g};${b}m${text[i]}\x1b[39m`;
	}
	return out;
}

function statusMark(status: MemberStatus | undefined, options?: WidgetRenderOptions): string {
	switch (status) {
		case "running":
			return paint(options, "accent", "◉ running");
		case "done":
			return paint(options, "success", "✓ done");
		case "failed":
			return paint(options, "error", "✗ failed");
		case "cancelled":
			return paint(options, "muted", "× cancelled");
		default:
			return paint(options, "dim", "○ queued");
	}
}

export function runLabel(run: ActiveRun): string {
	const mark = run.kind === "council" ? "⬡" : "⚔";
	const name = run.kind === "council" ? "Shadow Council" : "Shadow Arena";
	const extra = run.kind === "council" ? `${run.rolePreset} · ${run.mode}` : `${run.arenaProfile}`;
	const tmp = run.temporary ? " · tmp" : "";
	return `${mark} ${name} run ${run.seq}${tmp} · ${extra}`;
}

export function participantLabels(participants: Array<{ label: string }>): string {
	return participants.map((p) => p.label).join(" + ");
}

export function formatDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${Math.round(seconds % 60)}s`;
}

export function formatCost(cost: number | undefined): string {
	if (cost === undefined || !Number.isFinite(cost) || cost <= 0) return "";
	return `$${cost.toFixed(2)}`;
}

function usageBits(member: MemberState, now: number, options?: WidgetRenderOptions): string {
	const duration = member.durationMs ?? (member.status === "running" && member.startedAt ? now - member.startedAt : undefined);
	const parts: string[] = [];
	const durationText = formatDuration(duration);
	if (durationText) parts.push(paint(options, "dim", durationText));
	const costText = formatCost(member.cost);
	if (costText) parts.push(paint(options, "dim", costText));
	if (member.fallback) {
		const via = member.resolvedModel ? short(member.resolvedModel, 18) : "fallback";
		parts.push(paint(options, "error", `via ${via}`));
	}
	return parts.length ? `  ${parts.join("  ")}` : "";
}

function councilMemberLine(member: MemberState, mode: ActiveRun["mode"], now: number, options?: WidgetRenderOptions): string {
	const bits = [`${statusMark(member.stages.independent ?? member.status, options)} position`];
	if (mode !== "quick") bits.push(`${statusMark(member.stages.rebuttal, options)} rebuttal`);
	if (mode === "deep") bits.push(`${statusMark(member.stages["final-review"], options)} final`);
	return `${short(member.label, 16).padEnd(16)} ${bits.join("   ")}${usageBits(member, now, options)}`;
}

function arenaMemberLine(member: MemberState, now: number, options?: WidgetRenderOptions): string {
	const mark = statusMark(member.status, options);
	if (member.key === "judge") {
		return `${short(member.label, 16).padEnd(16)} ${mark} ${member.stage}${usageBits(member, now, options)}`;
	}
	return `${short(member.label, 16).padEnd(16)} ${mark} ${member.stage}${member.note ? ` · ${short(member.note, 24)}` : ""}${usageBits(member, now, options)}`;
}

function phaseCaption(run: ActiveRun): string {
	if (run.cancelRequested || run.phase === "cancelling") return "cancelling child agents…";
	if (run.awaitingEval) return "starting seats";
	if (run.statusMessage) return `${run.phase} · ${run.statusMessage}`;
	return run.phase;
}

export function visWidth(text: string): number {
	return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padVisible(text: string, width: number): string {
	const n = visWidth(text);
	if (n >= width) return text;
	return `${text}${" ".repeat(width - n)}`;
}

export function chatBannerLine(
	kind: "council" | "arena",
	id: string,
	width: number,
	style?: { fg: (tone: string, text: string) => string; bold: (text: string) => string },
): string {
	const title = kind === "arena" ? "Arena" : "Council";
	const label = ` ${title} · ${id} `;
	const w = Math.max(label.length + 8, width);
	const fill = w - label.length;
	const left = Math.floor(fill / 2);
	const right = fill - left;
	const dash = "─";
	if (!style) return `${dash.repeat(left)}${label}${dash.repeat(right)}`;
	return (
		style.fg("muted", dash.repeat(left)) +
		style.bold(style.fg("accent", label)) +
		style.fg("muted", dash.repeat(right))
	);
}

export function kindBanner(kind: ActiveRun["kind"] | "council" | "arena"): string {
	return kind === "arena" ? "Arena" : "Council";
}

export function kickoffCardLines(details: KickoffDetails, width = 72): string[] {
	return [chatBannerLine(details.kind, details.id, width)];
}

function frameWidget(inner: string[], width: number, options?: WidgetRenderOptions): string[] {
	const innerW = Math.max(8, width - 2);
	const top = inner[0] ?? "";
	const body = inner.slice(1);
	const bottom = `${paint(options, "muted", "╰")}${paint(options, "muted", "─".repeat(innerW))}${paint(options, "muted", "╯")}`;
	const rows = body.map((line) => `${paint(options, "muted", "│")}${padVisible(line, innerW)}${paint(options, "muted", "│")}`);
	return [top, ...rows, bottom];
}

export function widgetLines(run: ActiveRun, now = 0, options?: WidgetRenderOptions): string[] {
	const live = !isTerminalPhase(run.phase);
	const shimmer = options?.shimmer ?? (live && widgetShimmerEnabled());
	const width = options?.width ?? 56;
	const innerW = Math.max(8, width - 2);
	const frame = SPINNER[Math.floor(now / 80) % SPINNER.length] ?? "⠋";
	const title = `${kindBanner(run.kind)} · ${run.id}`;
	const titleText = live && shimmer ? wave(title, now) : paint(options, live ? "accent" : "muted", title);
	const prefix = live ? `${paint(options, "accent", frame)} ` : "";
	const heading = `${prefix}${titleText}`;
	const headingPad = ` ${heading} `;
	const fill = Math.max(0, innerW - visWidth(headingPad));
	const top = `${paint(options, "muted", "╭")}${headingPad}${paint(options, "muted", "─".repeat(fill))}${paint(options, "muted", "╮")}`;
	const members = Object.values(run.members);
	const visible = members.slice(0, 6);
	const inner = [
		top,
		` ${paint(options, "muted", "│")} ${paint(options, "muted", short(run.question, innerW - 4))}`,
	];
	if (live) inner.push(` ${paint(options, "muted", phaseCaption(run))}`);
	for (const member of visible) {
		inner.push(
			` ${run.kind === "council" ? councilMemberLine(member, run.mode, now, options) : arenaMemberLine(member, now, options)}`,
		);
	}
	if (members.length > visible.length) {
		inner.push(` ${paint(options, "muted", `… +${members.length - visible.length} more (Alt+A)`)}`);
	}
	if (!live) {
		const end = run.finishedAt ?? now;
		const wall = end >= run.startedAt ? end - run.startedAt : undefined;
		const cost = members.reduce((sum, member) => sum + (member.cost ?? 0), 0);
		const totalBits = [formatDuration(wall), formatCost(cost)].filter(Boolean);
		if (totalBits.length) inner.push(` ${paint(options, "dim", `total  ${totalBits.join("  ")}`)}`);
	}
	if (members.some((member) => member.fallback)) {
		inner.push(` ${paint(options, "error", "fallback: OMP retry chain, not the seat pin")}`);
	}
	if (run.kind === "council" && run.mode === "deep") {
		inner.push(
			` ${paint(
				options,
				"muted",
				`round ${run.phase === "final-review" || run.phase === "synthesizing" || run.phase === "done" ? "3/3" : run.phase === "rebuttal" ? "2/3" : "1/3"}`,
			)}`,
		);
	} else if (run.kind === "council" && run.mode === "debate") {
		inner.push(
			` ${paint(
				options,
				"muted",
				`round ${run.phase === "rebuttal" || run.phase === "synthesizing" || run.phase === "done" ? "2/2" : "1/2"}`,
			)}`,
		);
	}
	if (live) inner.push(` ${paint(options, "muted", `Esc cancel  ·  /${run.kind} cancel  ·  Alt+A`)}`);
	else if (run.kind === "arena" && run.phase === "done") {
		inner.push(` ${paint(options, "accent", "/arena apply  ·  /arena clear")}`);
	} else {
		inner.push(` ${paint(options, "muted", `/${run.kind} clear`)}`);
	}
	return frameWidget(inner, width, options);
}

export function renderWidget(state: RuntimeState, ctx: ExtensionContext | ExtensionCommandContext): void {
	if (!state.activeRun) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui, theme) => {
			const timer = setInterval(() => tui.requestRender(), 80);
			const paintFn: WidgetPaint = (tone, text) =>
				theme.fg(tone as "accent" | "muted" | "success" | "error" | "dim", text);
			return {
				render(width: number) {
					const run = state.activeRun;
					if (!run) return [];
					return widgetLines(run, Date.now(), {
						shimmer: widgetShimmerEnabled(),
						paint: paintFn,
						width,
					}).slice(0, 14);
				},
				invalidate() {},
				dispose() {
					clearInterval(timer);
				},
			};
		},
		{ placement: "aboveEditor" },
	);
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

export const kickoffRenderer: MessageRenderer<KickoffDetails> = (message, _options, theme) => {
	const details = message.details;
	if (!details) return undefined;
	return {
		render(width: number) {
			return [
				"",
				chatBannerLine(details.kind, details.id, width, {
					fg: (tone, text) => theme.fg(tone === "accent" ? "accent" : "muted", text),
					bold: (text) => theme.bold(text),
				}),
				"",
			];
		},
	};
};


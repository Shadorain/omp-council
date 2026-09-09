import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { councilConfigPath } from "./paths.ts";
import { DEFAULT_RETAIN_RUNS, MAX_RETAIN_RUNS } from "./types.ts";
import type { CouncilConfig, ParticipantConfig, RunKind } from "./types.ts";
export function clampRetain(value: unknown, fallback = DEFAULT_RETAIN_RUNS): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(0, Math.min(MAX_RETAIN_RUNS, Math.floor(n)));
}

export function retainLimit(kind: RunKind, config?: CouncilConfig): number {
	const resolved = config ?? readConfig();
	return kind === "arena" ? clampRetain(resolved?.retainArena) : clampRetain(resolved?.retainCouncil);
}

export function readConfig(): CouncilConfig | undefined {
	const path = councilConfigPath();
	if (!existsSync(path)) return undefined;
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CouncilConfig>;
	if (parsed.version !== 1 || !Array.isArray(parsed.participants)) {
		throw new Error(`Invalid Council config at ${path}. Expected { version: 1, participants: [...] }.`);
	}
	return {
		version: 1,
		participants: parsed.participants.filter(
			(item): item is ParticipantConfig =>
				!!item && typeof item.id === "string" && typeof item.label === "string" && typeof item.model === "string",
		),
		presets: parsed.presets && typeof parsed.presets === "object" ? parsed.presets : undefined,
		judgeModel: typeof parsed.judgeModel === "string" ? parsed.judgeModel : undefined,
		shimmer: parsed.shimmer === false ? false : parsed.shimmer === true ? true : undefined,
		retainCouncil: typeof parsed.retainCouncil === "number" ? clampRetain(parsed.retainCouncil) : undefined,
		retainArena: typeof parsed.retainArena === "number" ? clampRetain(parsed.retainArena) : undefined,
	};
}

export function writeConfig(config: CouncilConfig): void {
	const path = councilConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function extensionDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function configSummary(config: CouncilConfig | undefined): string {
	const loaded = `Loaded from: ${extensionDir()}`;
	if (!config) return `No saved Council model registry.\nConfig path: ${councilConfigPath()}\n${loaded}`;
	const lines = [
		`Council config: ${councilConfigPath()}`,
		loaded,
		`Participants (${config.participants.length}):`,
		...config.participants.map((p) => `  ${p.id}: ${p.label} -> ${p.model}`),
		`Arena judge: ${config.judgeModel ?? "current session model (dynamic)"}`,
		`Header wave: ${config.shimmer === false ? "off" : "on"} (OMP_COUNCIL_SHIMMER=0 to force off)`,
		`Retain council: ${retainLimit("council", config)} in council-runs.jsonl`,
		`Retain arena: ${retainLimit("arena", config)} in arena-runs.jsonl`,
	];
	if (config.presets && Object.keys(config.presets).length > 0) {
		lines.push("Presets:");
		for (const [name, ids] of Object.entries(config.presets)) lines.push(`  ${name}: ${ids.join(", ")}`);
	}
	return lines.join("\n");
}

export function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

export function slug(value: string): string {
	const result = value
		.trim()
		.toLowerCase()
		.replace(/^@/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return result || "model";
}

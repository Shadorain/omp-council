import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { councilConfigPath } from "./paths.ts";
import type { CouncilConfig, ParticipantConfig } from "./types.ts";

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
	};
}

export function writeConfig(config: CouncilConfig): void {
	const path = councilConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function configSummary(config: CouncilConfig | undefined): string {
	if (!config) return `No saved Council model registry.\nConfig path: ${councilConfigPath()}`;
	const lines = [
		`Council config: ${councilConfigPath()}`,
		`Participants (${config.participants.length}):`,
		...config.participants.map((p) => `  ${p.id}: ${p.label} -> ${p.model}`),
		`Arena judge: ${config.judgeModel ?? "current session model (dynamic)"}`,
		`Header wave: ${config.shimmer === false ? "off" : "on"} (OMP_COUNCIL_SHIMMER=0 to force off)`,
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

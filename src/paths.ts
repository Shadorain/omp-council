import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME } from "./types.ts";

export function agentDir(): string {
	return (
		process.env.PI_CODING_AGENT_DIR?.trim() ||
		process.env.OMP_AGENT_DIR?.trim() ||
		join(homedir(), ".omp", "agent")
	);
}

export function councilConfigPath(): string {
	return process.env.OMP_COUNCIL_CONFIG?.trim() || join(agentDir(), CONFIG_FILENAME);
}

export function runtimeAgentDir(): string {
	return join(agentDir(), "agents");
}

export function councilRunsDir(): string {
	return join(agentDir(), "council-runs");
}

export function runDumpPath(id: string): string {
	return join(councilRunsDir(), `${id}.json`);
}

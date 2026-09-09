import type { ActiveRun, ArenaProfile, RunKind } from "./types.ts";
import { KICKOFF_TYPE } from "./types.ts";
import { evalResultPath, writeEvalScript } from "./runtime-agents.ts";


export { KICKOFF_TYPE };


export const OPINION_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"recommendation",
		"reasoning",
		"assumptions",
		"risks",
		"alternatives",
		"confidence",
		"changedPosition",
		"criticisms",
		"concessions",
	],
	properties: {
		recommendation: { type: "string" },
		reasoning: { type: "array", items: { type: "string" } },
		assumptions: { type: "array", items: { type: "string" } },
		risks: { type: "array", items: { type: "string" } },
		alternatives: { type: "array", items: { type: "string" } },
		confidence: { type: "number", minimum: 0, maximum: 100 },
		changedPosition: { type: "boolean" },
		criticisms: { type: "array", items: { type: "string" } },
		concessions: { type: "array", items: { type: "string" } },
	},
};

export const ARENA_CANDIDATE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["approach", "summary", "filesChanged", "tests", "risks", "confidence", "diff", "diffTruncated"],
	properties: {
		approach: { type: "string" },
		summary: { type: "string" },
		filesChanged: { type: "array", items: { type: "string" } },
		tests: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["command", "status", "summary"],
				properties: {
					command: { type: "string" },
					status: { type: "string", enum: ["pass", "fail", "not-run"] },
					summary: { type: "string" },
				},
			},
		},
		risks: { type: "array", items: { type: "string" } },
		confidence: { type: "number", minimum: 0, maximum: 100 },
		diff: { type: "string" },
		diffTruncated: { type: "boolean" },
	},
};

export const ARENA_JUDGE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["winner", "decision", "confidence", "rankings", "criteria"],
	properties: {
		winner: { type: "string" },
		decision: { type: "string" },
		confidence: { type: "number", minimum: 0, maximum: 100 },
		rankings: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["candidate", "score", "reason"],
				properties: {
					candidate: { type: "string" },
					score: { type: "number", minimum: 0, maximum: 100 },
					reason: { type: "string" },
				},
			},
		},
		criteria: {
			type: "object",
			additionalProperties: false,
			required: ["correctness", "verification", "quality", "simplicity", "architecture"],
			properties: {
				correctness: { type: "string" },
				verification: { type: "string" },
				quality: { type: "string" },
				simplicity: { type: "string" },
				architecture: { type: "string" },
			},
		},
	},
};

export function js(value: unknown): string {
	return JSON.stringify(value);
}

export function isSmokeQuestion(question: string): boolean {
	return /^(test|testing|ping|hello|hi|ok|lorem)[\s!.]*$/i.test(question.trim());
}


export function arenaVerification(profile: ArenaProfile): string {
	if (profile === "rust") {
		return [
			"This is a Rust arena. Before yielding, run appropriate targeted checks and, when feasible, these hard gates:",
			"cargo fmt --check",
			"cargo check --workspace --all-targets",
			"cargo clippy --workspace --all-targets -- -D warnings",
			"cargo test --workspace",
			"If a project-wide command is impractical due to known resource limits, run the strongest narrower equivalent and state exactly what was not verified.",
		].join("\\n");
	}
	return "Run the strongest project-appropriate formatting, static analysis, build/typecheck, and tests that are practical. Record every command and outcome.";
}

export function councilEvalCode(run: ActiveRun): string {
	const members = run.participants.map((participant) => ({
		key: participant.key,
		label: participant.label,
		model: participant.model,
		agent: participant.agent,
		lens: participant.lens,
	}));

	return `return await (async () => {
  const run = ${js({ id: run.id, question: run.question, mode: run.mode, rolePreset: run.rolePreset, smoke: isSmokeQuestion(run.question), resultPath: evalResultPath(run) })};
  const members = ${js(members)};
  const schema = ${js(OPINION_SCHEMA)};
  const progress = async (phase, member, status, message, extra) => {
    try { await tool.council_progress({ runId: run.id, phase, member, status, message, ...extra }); } catch (_) {}
  };
  const release = async (list) => {
    for (const handle of list) {
      if (!handle) continue;
      try { await handle.cancel(); } catch (_) {}
    }
  };
  const safe = async (handle, member, stage) => {
    const t0 = Date.now();
    try {
      const data = await handle.wait();
      await progress(stage, member.key, "done", "complete", { durationMs: Date.now() - t0 });
      return { member: member.key, handle: handle.handle, data };
    } catch (error) {
      await progress(stage, member.key, "failed", String(error), { durationMs: Date.now() - t0 });
      try { await handle.cancel(); } catch (_) {}
      return { member: member.key, handle: handle.handle, error: String(error) };
    }
  };

  phase("Council independent round");
  await progress("independent", "", "running", "starting");
  const handles = [];
  for (const member of members) {
    await progress("independent", member.key, "running", "analyzing");
    const prompt = [
      "You are one member of an adversarial engineering council.",
      "Work independently; do not assume consensus is correct.",
      "Assigned lens: " + member.lens,
      "Question/task:", run.question,
      run.smoke
        ? "This is a harness smoke check, not a product question. Return a short valid opinion that the Council run works. Do not review tests, architecture, or the repository."
        : "Inspect the repository when relevant. Separate facts, assumptions, and preferences.",
      "For this initial round set changedPosition=false, criticisms=[], and concessions=[].",
      "Do not invoke /council or /arena.",
      "Return only the requested structured result."
    ].join("\\n\\n");

    handles.push(await agent(prompt, {
      agent: member.agent,
      label: run.id + "-" + member.key + "-position",
      schema,
      schemaMode: "strict",
    }));
  }
  const initial = await Promise.all(handles.map((h, i) => safe(h, members[i], "independent")));

  let rebuttals = null;
  let finalReview = null;
  if (run.mode !== "quick") {
    phase("Council adversarial rebuttal");
    await progress("rebuttal", "", "running", "cross-review");
    for (let i = 0; i < handles.length; i++) {
      const peers = initial
        .filter((_, j) => j !== i)
        .map((item, n) => ({ peer: "Peer " + (n + 1), opinion: item.data ?? { error: item.error } }));
      await progress("rebuttal", members[i].key, "running", "challenging peers");
      await handles[i].send([
        "Adversarial review round. These are anonymized competing positions:",
        JSON.stringify(peers),
        "Attack unsupported assumptions and technical mistakes. Identify what you missed. Defend material disagreements, but revise when another argument is stronger.",
        "Return the same structured schema. Set changedPosition and use criticisms/concessions where applicable."
      ].join("\\n\\n"));
    }
    rebuttals = await Promise.all(handles.map((h, i) => safe(h, members[i], "rebuttal")));
  }

  if (run.mode === "deep") {
    phase("Council final review");
    await progress("final-review", "", "running", "final challenge");
    const evidence = (rebuttals ?? initial).map((item, n) => ({ peer: "Position " + (n + 1), opinion: item.data ?? { error: item.error } }));
    for (let i = 0; i < handles.length; i++) {
      await progress("final-review", members[i].key, "running", "final reconsideration");
      await handles[i].send([
        "Final council round. Review the full anonymized post-rebuttal evidence:",
        JSON.stringify(evidence),
        "State your final recommendation. Focus only on decisive unresolved technical issues; do not repeat settled points. Return the same schema."
      ].join("\\n\\n"));
    }
    finalReview = await Promise.all(handles.map((h, i) => safe(h, members[i], "final-review")));
  }

  const result = {
    kind: "council",
    runId: run.id,
    mode: run.mode,
    rolePreset: run.rolePreset,
    participants: members.map(m => ({ key: m.key, label: m.label, model: m.model, lens: m.lens })),
    initial,
    rebuttals,
    finalReview,
  };
  await progress("synthesizing", "", "done", "council evidence ready");
  await release(handles);
  if (run.resultPath) {
    try { await Bun.write(run.resultPath, JSON.stringify(result)); } catch (_) {}
    const last = result.finalReview || result.rebuttals || result.initial || [];
    return last.map((item) => {
      const m = members.find((x) => x.key === item.member);
      const d = item.data;
      return (m ? m.label : item.member) + (d ? " · " + String(d.recommendation || "") : " · " + String(item.error || "failed"));
    }).join("\\n") || result.runId;
  }
  return result;

})();`;
}

export function arenaEvalCode(run: ActiveRun): string {
	const members = run.participants.map((participant) => ({
		key: participant.key,
		label: participant.label,
		model: participant.model,
		agent: participant.agent,
	}));
	const labels = members.map((_, index) => String.fromCharCode(65 + index));
	const profile = run.arenaProfile ?? "general";

	return `return await (async () => {
  const run = ${js({ id: run.id, question: run.question, profile, judgeAgent: run.judgeAgent, smoke: isSmokeQuestion(run.question), resultPath: evalResultPath(run) })};

  const members = ${js(members)};
  const labels = ${js(labels)};
  const candidateSchema = ${js(ARENA_CANDIDATE_SCHEMA)};
  const judgeSchema = ${js(ARENA_JUDGE_SCHEMA)};
  const verification = ${js(arenaVerification(profile))};
  const progress = async (phase, member, status, message, extra) => {
    try { await tool.council_progress({ runId: run.id, phase, member, status, message, ...extra }); } catch (_) {}
  };
  const release = async (list) => {
    for (const handle of list) {
      if (!handle) continue;
      try { await handle.cancel(); } catch (_) {}
    }
  };

  phase("Arena isolated implementations");
  await progress("implementing", "", "running", "starting isolated candidates");
  const handles = [];
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    await progress("implementing", member.key, "running", "candidate " + labels[i]);
    const prompt = [
      "You are Candidate " + labels[i] + " in a blind implementation arena.",
      "Implement the requested task in your isolated workspace. Do not merely propose a plan.",
      "Task:", run.question,
      verification,
      "Keep the implementation focused and production-quality.",
      "Before yielding, obtain the unified git diff. Return the complete diff when <= 25000 characters; otherwise return the highest-value hunks and set diffTruncated=true.",
      "Do not invoke /council or /arena.",
      "Return only the requested structured result."
    ].join("\\n\\n");
    handles.push(await agent(prompt, {
      agent: member.agent,
      label: run.id + "-candidate-" + labels[i],
      schema: candidateSchema,
      schemaMode: "strict",
      isolated: true,
      apply: false,
      merge: false,
    }));
  }

  const candidates = await Promise.all(handles.map(async (handle, i) => {
    const t0 = Date.now();
    try {
      const data = await handle.wait();
      await progress("implementing", members[i].key, "done", "candidate " + labels[i] + " complete", { durationMs: Date.now() - t0 });
      return { candidate: labels[i], data };
    } catch (error) {
      await progress("implementing", members[i].key, "failed", String(error), { durationMs: Date.now() - t0 });
      try { await handle.cancel(); } catch (_) {}
      return { candidate: labels[i], error: String(error) };
    }
  }));

  phase("Arena blind judging");
  await progress("judging", "judge", "running", "blind judge");
  const anonymized = candidates.map(c => ({ candidate: c.candidate, data: c.data, error: c.error }));
  const judgePrompt = [
    "You are the blind judge for an implementation arena. Provider/model identities are intentionally hidden.",
    "Task:", run.question,
    "Candidates:", JSON.stringify(anonymized),
    "Rank only the technical work. Do not infer model identity.",
    "Scoring guidance: correctness 35%, verification/test evidence 25%, code quality 15%, simplicity 10%, architecture/maintainability 15%.",
    "A candidate with failed hard verification should normally not win unless every candidate fails and you clearly explain why.",
    "Prefer a smaller correct diff over speculative complexity.",
    "Do not invoke /council or /arena."
  ].join("\\n\\n");
  let judgement;
  let judgeHandle;
  const judgeStarted = Date.now();
  try {
    judgeHandle = await agent(judgePrompt, {
      agent: run.judgeAgent,
      label: run.id + "-blind-judge",
      schema: judgeSchema,
      schemaMode: "strict",
    });
    judgement = await judgeHandle.wait();
    await progress("judging", "judge", "done", "winner " + judgement.winner, { durationMs: Date.now() - judgeStarted });
  } catch (error) {
    if (judgeHandle) try { await judgeHandle.cancel(); } catch (_) {}
    await progress("judging", "judge", "failed", String(error), { durationMs: Date.now() - judgeStarted });
    throw error;
  }

  const reveal = {};
  for (let i = 0; i < members.length; i++) {
    reveal[labels[i]] = { label: members[i].label, model: members[i].model, handle: handles[i].handle };
  }
  const result = { kind: "arena", runId: run.id, profile: run.profile, candidates, judgement, reveal };
  await progress("synthesizing", "", "done", "winner " + judgement.winner);
  await release([...handles, judgeHandle]);
  if (run.resultPath) {
    try { await Bun.write(run.resultPath, JSON.stringify(result)); } catch (_) {}
    return "winner " + (judgement && judgement.winner ? judgement.winner : "?");
  }
  return result;

})();`;
}

export function evalInputFor(run: ActiveRun): Record<string, unknown> {
	const body = run.kind === "council" ? councilEvalCode(run) : arenaEvalCode(run);
	const script = body.startsWith("return await ") ? body.slice("return await ".length) : body;
	writeEvalScript(run, script);
	const resultPath = evalResultPath(run);
	if (!run.runtimeAgentPaths.includes(resultPath)) run.runtimeAgentPaths.push(resultPath);
	const kind = run.kind === "arena" ? "Arena" : "Council";
	const seats = run.participants.map((participant) => participant.label).join(", ");
	return {
		language: "js",
		title: `${kind} ${run.id} · ${seats}`,
		timeout: 0,
		code: `return await (0, eval)(await Bun.file(${js(run.runtimeAgentPaths.find((item) => item.endsWith(".js")) ?? "")}).text());`,
	};
}

export function findFinalJson(details: unknown, kind: RunKind, runId: string): unknown {
	const seen = new Set<unknown>();
	const walk = (value: unknown): unknown => {
		if (!value || typeof value !== "object" || seen.has(value)) return undefined;
		seen.add(value);
		const record = value as Record<string, unknown>;
		if (record.kind === kind && record.runId === runId) return record;
		if (Array.isArray(value)) {
			for (const item of value) {
				const found = walk(item);
				if (found) return found;
			}
		} else {
			for (const item of Object.values(record)) {
				const found = walk(item);
				if (found) return found;
			}
		}
		return undefined;
	};
	return walk(details);
}


export interface KickoffDetails {
	id: string;
	kind: RunKind;
	mode?: string;
	rolePreset?: string;
	arenaProfile?: string;
	temporary: boolean;
	question: string;
	seats: string[];
	judge?: string;
}

export function kickoffDetails(run: ActiveRun): KickoffDetails {
	return {
		id: run.id,
		kind: run.kind,
		mode: run.mode,
		rolePreset: run.rolePreset,
		arenaProfile: run.arenaProfile,
		temporary: run.temporary,
		question: run.question,
		seats: run.participants.map((participant) => participant.label),
		judge: run.judgeModel,
	};
}

export function chairTurnContent(run: ActiveRun): string {
	const kind = run.kind === "arena" ? "Arena" : "Council";
	const bits = [run.id];
	if (run.temporary) bits.push("tmp");
	if (run.mode) bits.push(run.mode);
	if (run.rolePreset) bits.push(run.rolePreset);
	if (run.arenaProfile) bits.push(run.arenaProfile);
	return `${kind} ${bits.join(" · ")}\n\nCall eval once. Do not search the repo.`;
}

export function userFacingKickoff(run: ActiveRun): string {
	return chairTurnContent(run);
}

export function chairInstruction(run: ActiveRun): string {
	const smoke = isSmokeQuestion(run.question)
		? `The question ${JSON.stringify(run.question)} is a harness smoke check. It is not a request to review tests, architecture, or the repository. After eval, report only that seats finished and whether the structured output is valid.`
		: `Question:\n${run.question}`;
	if (run.kind === "council") {
		return `Shadow Council ${run.id} is active. ${smoke} Your first action is the eval tool, exactly once. The Council extension replaces that eval with deterministic seat orchestration. Do not read, grep, glob, bash, or spawn task agents before eval returns. After eval returns, synthesize its structured evidence. Do not choose by majority vote.`;
	}
	return `Shadow Arena ${run.id} is active. ${smoke} Your first action is the eval tool, exactly once. The Arena extension replaces that eval with deterministic candidate orchestration. Do not read, grep, glob, bash, or spawn task agents before eval returns. After eval returns, report the blind judge result, then reveal which model produced each candidate. Do not apply changes unless I run /arena apply.`;
}


export function applyChairSystemPrompt(systemPrompt: string[], run: ActiveRun): string[] {
	return [...systemPrompt, chairInstruction(run)];
}

export function kickoffPrompt(run: ActiveRun): string {
	return chairInstruction(run);
}

export function isKickoffPrompt(text: string): boolean {
	return (
		text.includes("This is not a normal chat turn.") ||
		(/\[OMP (?:COUNCIL|ARENA) /.test(text) && text.includes("Call the eval tool exactly once")) ||
		(text.includes("Shadow Council") && text.includes("Call the eval tool exactly once")) ||
		(text.includes("Shadow Arena") && text.includes("Call the eval tool exactly once"))
	);
}


export function sessionStopNudge(run: ActiveRun): string {
	return `${run.kind === "arena" ? "Arena" : "Council"} extension ${run.id} is awaiting its deterministic orchestration call. Call eval exactly once now; the extension will replace the input.`;
}

export function isChairPlumbing(text: string): boolean {
	return isKickoffPrompt(text) || text.includes("awaiting its deterministic orchestration call");
}

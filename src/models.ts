import type { ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ModelLike } from "./types.ts";

export function selectorForModel(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

export function labelForModel(model: ModelLike): string {
	return model.name?.trim() || model.id;
}

export function listModels(ctx: ExtensionContext | ExtensionCommandContext): ModelLike[] {
	const models = ctx.models.list() as ModelLike[];
	return [...models].sort((a, b) => {
		const provider = a.provider.localeCompare(b.provider);
		if (provider !== 0) return provider;
		return labelForModel(a).localeCompare(labelForModel(b));
	});
}

export function currentModelSelector(ctx: ExtensionContext | ExtensionCommandContext): string | undefined {
	const current = ctx.models.current() as ModelLike | undefined;
	return current ? selectorForModel(current) : undefined;
}

export function resolveModel(ctx: ExtensionContext | ExtensionCommandContext, spec: string): ModelLike | undefined {
	return ctx.models.resolve(spec) as ModelLike | undefined;
}

export function exactSelector(ctx: ExtensionContext | ExtensionCommandContext, spec: string): string | undefined {
	const model = resolveModel(ctx, spec);
	return model ? selectorForModel(model) : undefined;
}

export function modelChoiceLabel(model: ModelLike): string {
	return `${labelForModel(model)}  [${selectorForModel(model)}]`;
}

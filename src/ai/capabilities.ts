/**
 * Extended-thinking models reject tool_choice type "tool" and "any".
 * The set below is the known list. A live 400 also records the model so the next call skips the forced choice.
 */
const NO_FORCED_TOOL_CHOICE = [/claude-sonnet-5/i, /claude-opus-4/i, /claude-opus-5/i, /thinking/i];

const learnedRejection = new Set<string>();

export function modelId(model: string): string {
  const idx = model.indexOf(":");
  return (idx > 0 ? model.slice(idx + 1) : model).trim();
}

export function supportsForcedToolChoice(model: string): boolean {
  const id = modelId(model);
  if (learnedRejection.has(id)) return false;
  return !NO_FORCED_TOOL_CHOICE.some((pattern) => pattern.test(id));
}

export function rememberForcedToolChoiceRejected(model: string): void {
  learnedRejection.add(modelId(model));
}

export function resetForcedToolChoiceMemory(): void {
  learnedRejection.clear();
}

export function isForcedToolChoiceError(message: string): boolean {
  return /tool_choice/i.test(message) && /not supported/i.test(message);
}

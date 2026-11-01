/** Add newly chosen files onto the ones already waiting. A later selection does not replace the list. */
export function appendAttachments<T>(current: readonly T[], incoming: ArrayLike<T> | null | undefined): T[] {
  const next = current.slice();
  if (!incoming) return next;
  for (let index = 0; index < incoming.length; index += 1) next.push(incoming[index]);
  return next;
}

/** Drop one waiting file. The rest stay. */
export function removeAttachment<T>(current: readonly T[], index: number): T[] {
  if (index < 0 || index >= current.length) return current.slice();
  return current.filter((_, item) => item !== index);
}

function isUpload(value: unknown): value is { name?: string; arrayBuffer: () => Promise<ArrayBuffer> } {
  return typeof value === "object" && value != null && typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function";
}

/** Every file in a multipart field. One file, or several under the same name. */
export function filesFromField(value: unknown): { name: string; arrayBuffer: () => Promise<ArrayBuffer> }[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  const files: { name: string; arrayBuffer: () => Promise<ArrayBuffer> }[] = [];
  for (const item of list) {
    if (!isUpload(item)) continue;
    files.push({ name: item.name || "upload", arrayBuffer: () => item.arrayBuffer() });
  }
  return files;
}

export function fieldText(value: unknown): string {
  if (Array.isArray(value)) return fieldText(value[0]);
  return typeof value === "string" ? value : "";
}

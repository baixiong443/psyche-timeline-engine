function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)])
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export async function sha256Text(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  return sha256Bytes(data);
}

export async function sha256Bytes(data: ArrayBuffer | ArrayBufferView<ArrayBufferLike>): Promise<string> {
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

export async function hashJson(value: unknown): Promise<string> {
  return sha256Text(stableJson(value));
}

/** Harness-neutral token estimate used for all user-facing size budgets. */
export const BYTES_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
	return text ? Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN) : 0;
}

export function estimateTokensFromBytes(bytes: number): number {
	return Math.ceil(Math.max(0, bytes) / BYTES_PER_TOKEN);
}

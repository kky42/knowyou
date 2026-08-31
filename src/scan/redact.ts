const PATTERNS: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style keys
	/\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub PATs
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g, // AWS access keys
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
	/\bBearer\s+[A-Za-z0-9._-]{24,}\b/gi,
	/\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
	/(["']?(?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["'])[^"'\s]{8,}(["'])/gi,
];

const REPLACEMENT = "[REDACTED]";

export function redactSecrets(text: string): string {
	let out = text;
	for (const pattern of PATTERNS) out = out.replace(pattern, REPLACEMENT);
	return out;
}

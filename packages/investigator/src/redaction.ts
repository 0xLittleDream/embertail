// Redact before any context leaves the server, including follow-ups and source.
const sensitiveKey =
  /(?:private.?key|api.?key|secret|password|passphrase|credential|authorization|auth.?token|_TOKEN$|^token$|cookie|signing|signature|mnemonic|seed.?phrase|access.?token|refresh.?token|signed.?transaction|raw.?transaction|keystore|^rawtx$|^headers$|^proof$|^env$|^environmentVariables$)/i;
export function redactText(text: string, secrets: string[] = []): string {
  let clean = text;
  for (const secret of secrets.filter((s) => s.length >= 4))
    clean = clean.split(secret).join('[REDACTED]');
  return clean
    .replace(
      /-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?-----END [\w ]*PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(
      /\b(?:sk-(?:or-v1-|ant-[\w-]*|proj-)?[\w-]{8,}|gh[pousr]_[\w]{12,}|AKIA[0-9A-Z]{16})\b/g,
      '[REDACTED KEY]',
    )
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[REDACTED TOKEN]')
    .replace(/\b0x[0-9a-fA-F]{130,}\b/g, '[REDACTED SIGNING MATERIAL]')
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, '[REDACTED 32-BYTE VALUE]')
    .replace(/\b[0-9a-fA-F]{64}\b/g, '[REDACTED 32-BYTE VALUE]')
    .replace(
      /((?:private.?key|api.?key|secret|password|mnemonic|seed.?phrase|authorization|cookie|access.?token)\s*["']?\s*[:=]\s*)[^\n,;]+/gi,
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
export function redact<T>(value: T, secrets: string[] = []): T {
  function visit(v: unknown): unknown {
    if (typeof v === 'string') return redactText(v, secrets);
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          sensitiveKey.test(k) && !(k === 'signingClaim' && (typeof x === 'string' || x === null))
            ? '[REDACTED]'
            : visit(x),
        ]),
      );
    return v;
  }
  return visit(value) as T;
}
export const environmentSecrets = (env: NodeJS.ProcessEnv) =>
  Object.entries(env)
    .filter(([k]) => sensitiveKey.test(k))
    .map(([, v]) => v ?? '');

/**
 * Best-effort secret redaction for anything uploaded to Honcho. Ported from
 * claude-honcho / dsh-honcho so the integrations scrub identically.
 *
 * Regex-based, so novel secret formats pass through; users extend the defaults
 * via `capture.noisePatterns`. This runs on EVERY captured message — a coding
 * harness has whatever is on screen in its buffer, and capture without
 * scrubbing is an exfiltration path.
 */

const DEFAULT_RULES = [
  // KEY=value assignments with a secret-bearing key
  {
    pattern:
      /\b(\w*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_?KEY|ACCESS_KEY|CREDENTIALS?)\w*)\s*=\s*("[^"]*"|'[^']*'|[^\s;|&"']+)/gi,
    replacement: "$1=***",
  },
  // --password / --token style CLI flags
  {
    pattern: /(--(?:password|passwd|pwd|token|api-?key|secret|auth)[= ])(?:"[^"]*"|'[^']*'|[^\s;|&"']+)/gi,
    replacement: "$1***",
  },
  // Authorization headers
  {
    pattern: /(authorization:\s*(?:bearer|basic|token)\s+)[^\s"']+/gi,
    replacement: "$1***",
  },
  // Credentials embedded in URLs (scheme://user:pass@host)
  {
    pattern: /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s]+@/gi,
    replacement: "$1***@",
  },
  // Well-known token shapes: Honcho, AWS, OpenAI/Anthropic-style sk-, GitHub,
  // Slack, GitLab, npm
  {
    pattern:
      /\b(?:hch[_-]?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{16,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36})\b/g,
    replacement: "***",
  },
];

/**
 * Redact secrets from `text`. `extraPatterns` are additive to the built-in
 * defaults. Patterns that fail to compile are skipped — a hand-edited config
 * file must not be able to break capture.
 */
export function redactSecrets(text, extraPatterns) {
  let result = text;
  for (const rule of DEFAULT_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  for (const source of extraPatterns ?? []) {
    try {
      result = result.replace(new RegExp(source, "gi"), "***");
    } catch {
      continue;
    }
  }
  return result;
}

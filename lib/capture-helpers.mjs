/**
 * Capture helpers ported from dsh-honcho's `src/capture.ts`: what counts as a
 * message worth remembering, and what is harness noise.
 */

import { readFileSync } from "node:fs";

/**
 * Shell commands that read rather than change anything. A review or search
 * turn would otherwise flood memory with `ran: grep ...` lines that say nothing
 * about the user. Ported from codex-honcho's list.
 */
const READ_ONLY_SHELL = [
  "cd", "ls", "pwd", "echo", "cat", "head", "tail", "which", "type", "grep", "rg", "find", "fd",
  "wc", "sed", "awk", "less", "more", "stat", "file", "tree", "du", "df", "env", "printf",
  "sort", "uniq", "cut", "jq", "open", "true", "sleep", "date",
  "git status", "git log", "git diff", "git show", "git branch",
];

const SHELL_TOOLS = new Set(["bash", "shell", "pwsh", "exec", "run_code"]);

/** One line describing a tool call, or "" when it carries no user signal. */
export function summarizeTool(name, args) {
  if (!name) return "";
  // Recording that we queried memory is circular noise in the representation.
  if (name.startsWith("honcho_")) return "";
  if (name.startsWith("mcp__honcho__")) return "";

  if (SHELL_TOOLS.has(name.toLowerCase())) {
    const raw = args?.command ?? args?.cmd ?? args?.code;
    const command = (Array.isArray(raw) ? raw.join(" ") : typeof raw === "string" ? raw : "").trim();
    if (!command) return "";
    if (READ_ONLY_SHELL.some((t) => command === t || command.startsWith(`${t} `))) return "";
    return `ran: ${command.slice(0, 120)}`;
  }

  const path = args?.path ?? args?.file_path ?? args?.filePath;
  if (typeof path === "string" && path) {
    const verb = /write|edit|create/i.test(name) ? "edited" : "read";
    if (verb === "read") return "";
    return `edited: ${path}`;
  }

  return `used ${name}`;
}

/**
 * Prompts the harness injected rather than the user typing them. Covers both
 * the dsh shapes and the ZCode ones (system reminders, command wrappers,
 * task notifications).
 */
const HARNESS_INJECTED = [
  /^<[a-z-]+-reminder>/i,
  /^<command-(?:name|message|args)>/i,
  /^\[SYSTEM NOTIFICATION/i,
  /^<task-notification>/i,
  /^Caveat: The messages below were generated/i,
  /^<system-reminder>/i,
];

export function isHarnessInjected(text) {
  const trimmed = text.trim();
  return HARNESS_INJECTED.some((p) => p.test(trimmed));
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/**
 * Pull the last assistant text out of a session transcript (JSONL), scanning
 * from the end. Tolerates both the Claude Code shape
 * (`{type:"assistant", message:{content:[...]}}`) and flatter shapes.
 * Returns "" when nothing usable is found.
 */
export function lastAssistantText(transcriptPath) {
  let lines;
  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    if (!raw) return "";
    lines = raw.split("\n");
  } catch {
    return "";
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const role = entry?.type ?? entry?.role ?? entry?.message?.role;
    if (role !== "assistant") continue;
    const text = extractText(entry?.message?.content ?? entry?.content ?? entry?.text);
    if (text.trim()) return text;
  }
  return "";
}

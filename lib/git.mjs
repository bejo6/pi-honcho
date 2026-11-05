/**
 * Minimal git context for session naming. Ported from dsh-honcho's `src/git.ts`:
 * two bounded calls, both failing to `undefined` rather than throwing.
 */

import { execFileSync } from "node:child_process";

function git(cwd, args) {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = out.trim();
    return value || undefined;
  } catch {
    // Not a repo, git absent, detached HEAD, timeout — all "no git context".
    return undefined;
  }
}

/** Current branch, or undefined outside a repo / on a detached HEAD. */
export function currentBranch(cwd) {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch === "HEAD" ? undefined : branch;
}

/** Repository root. A worktree resolves to its own root. */
export function repoRoot(cwd) {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

/**
 * The `origin` remote URL as configured — not `git remote get-url`, which
 * applies each machine's `url.<base>.insteadOf` rewrites. The raw URL is what
 * stays comparable across machines.
 */
export function originRemote(cwd) {
  return git(cwd, ["config", "--get", "remote.origin.url"]);
}

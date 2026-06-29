/**
 * Gate classification for the per-gate safety policy (Tier 2).
 *
 * Claude's TUI surfaces several kinds of interstitial "gate" dialogs: the
 * first-run trust prompt, MCP-server approval, and per-tool permission prompts.
 * Today the session auto-confirms them all. This classifies each gate so the
 * session can auto-approve the safe ones but ESCALATE the dangerous ones
 * (destructive shell, force-push, secrets, network exfil, …) to the human.
 *
 * Classification is heuristic, read from the clean emulator screen text, and
 * conservative on the well-known dangerous set. Benign permission prompts (file
 * edits/reads, `npm test`, `mkdir`, …) stay "safe" so the normal flow isn't
 * interrupted.
 */
export type GateKind = "trust" | "mcp" | "permission" | "unknown";
export type GateDanger = "safe" | "dangerous";

export interface GateClassification {
  kind: GateKind;
  danger: GateDanger;
  /** Short human-readable description of what the gate is asking to do. */
  summary: string;
}

const TRUST_RE = /trust this folder|Is this a project you|Yes, I trust this folder/i;
// The MCP APPROVAL DIALOG only — NOT the persistent "N MCP server needs
// authentication" status line, which would otherwise match every screen.
const MCP_RE = /New MCP server found|Use this and all future MCP server/i;
const PERMISSION_RE =
  /Do you want to proceed|Do you want to run|Do you want to make this edit|Do you want to create/i;

/**
 * Actions that warrant a human decision before auto-approving. Tuned to catch
 * the clearly-catastrophic set without flagging everyday commands. `rm` only
 * trips on a recursive/force flag, not `rm one-file.txt`.
 */
const DANGEROUS_RE =
  /\brm\s+-[a-z]*[rf]|\brm\s+-rf\b|\brmdir\s+\/s|\bdel\s+\/[sq]|git\s+push[^\n]*(--force|--force-with-lease|\s-f\b)|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|\bsudo\b|\bchmod\s+(-R\s+)?777|\bcurl\b|\bwget\b|Invoke-WebRequest|\biwr\b|\|\s*(sh|bash|zsh)\b|\biex\b|\bshutdown\b|\breg\s+delete\b|\bDROP\s+TABLE\b|\bDELETE\s+FROM\b|\bTRUNCATE\b|\bmkfs\b|\bformat\s+[A-Za-z]:|>\s*\/dev\/sd|\bnpm\s+publish\b|\bpip\s+install[^\n]*--user\b|\.env\b|\bsecret[s]?\b|\bcredential[s]?\b|\bprivate[_-]?key\b|\bid_rsa\b/i;

/** Pull the most relevant command/path line out of a gate screen for the summary. */
function extractSummary(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^[❯●⎿>\s]+/, "").trim()) // drop input-echo / bullet prefixes
    .filter(Boolean);
  // Prefer the SHORTEST line that matched a dangerous pattern — that's the bare
  // command in the dialog, not the long echoed user prompt.
  const hits = lines.filter((l) => DANGEROUS_RE.test(l)).sort((a, b) => a.length - b.length);
  if (hits[0]) return hits[0].slice(0, 100);
  // Otherwise the line after a tool header (Bash command / Edit file / …).
  const idx = lines.findIndex((l) => /^(Bash|Edit|Write|Read|command|Running)\b/i.test(l));
  if (idx >= 0 && lines[idx + 1]) return lines[idx + 1]!.slice(0, 100);
  return "an action";
}

export function classifyGate(text: string): GateClassification {
  // Check the actionable PERMISSION prompt first — it's the one whose danger
  // matters, and other UI noise (e.g. the "MCP needs auth" status line) can be
  // present on the same screen.
  if (PERMISSION_RE.test(text)) {
    if (DANGEROUS_RE.test(text)) {
      return { kind: "permission", danger: "dangerous", summary: extractSummary(text) };
    }
    return { kind: "permission", danger: "safe", summary: extractSummary(text) };
  }

  if (TRUST_RE.test(text)) return { kind: "trust", danger: "safe", summary: "trust this folder" };
  if (MCP_RE.test(text)) return { kind: "mcp", danger: "safe", summary: "use MCP server" };

  // Unknown gate shape — auto-confirm to preserve the smooth flow rather than block.
  return { kind: "unknown", danger: "safe", summary: "continue" };
}

/**
 * Deterministic tests for quiet hours (src/policy/quiethours.ts) and the notifier
 * gating it drives. Time is injected (fixed epoch ms), so no real clock is used.
 */
import { inQuietHours, suppresses, describeQuietHours } from "../src/policy/quiethours.js";
import { Notifier, type NotifyContext } from "../src/notify/notifier.js";
import type { QuietHours, WebhookConfig } from "../src/types.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// A local wall-clock helper: build epoch ms for a given Y/M/D H:M in LOCAL time
// (matches how inQuietHours reads the clock, regardless of the test host's zone).
const at = (y: number, mo: number, d: number, h: number, m: number) =>
  new Date(y, mo - 1, d, h, m, 0, 0).getTime();

// ── daytime window (09:00–17:00) ────────────────────────────────────────────────
const day: QuietHours = { enabled: true, start: "09:00", end: "17:00" };
check("inside daytime window", inQuietHours(day, at(2026, 6, 1, 12, 0)));
check("before window not quiet", !inQuietHours(day, at(2026, 6, 1, 8, 59)));
check("at start boundary is quiet (inclusive)", inQuietHours(day, at(2026, 6, 1, 9, 0)));
check("at end boundary not quiet (exclusive)", !inQuietHours(day, at(2026, 6, 1, 17, 0)));

// ── overnight window (22:00–07:00) ──────────────────────────────────────────────
const night: QuietHours = { enabled: true, start: "22:00", end: "07:00" };
check("late evening is quiet", inQuietHours(night, at(2026, 6, 1, 23, 30)));
check("early morning (next day) is quiet", inQuietHours(night, at(2026, 6, 2, 6, 0)));
check("midday not quiet (overnight)", !inQuietHours(night, at(2026, 6, 1, 12, 0)));
check("07:00 end boundary not quiet", !inQuietHours(night, at(2026, 6, 2, 7, 0)));

// ── weekday restriction (Mon–Fri nights) ─────────────────────────────────────────
// 2026-06-01 is a Monday. days keyed by the START day of the window.
const weeknight: QuietHours = { enabled: true, start: "22:00", end: "07:00", days: [1, 2, 3, 4, 5] };
check("Mon 23:00 quiet (Monday in days)", inQuietHours(weeknight, at(2026, 6, 1, 23, 0)));
check("Tue 06:00 quiet (window started Mon)", inQuietHours(weeknight, at(2026, 6, 2, 6, 0)));
// 2026-06-06 is a Saturday → not in days; Sat 23:00 must NOT be quiet.
check("Sat 23:00 not quiet (Saturday excluded)", !inQuietHours(weeknight, at(2026, 6, 6, 23, 0)));
// Sun 06:00 = window that started Sat 22:00 (Sat excluded) → not quiet.
check("Sun 06:00 not quiet (started Saturday)", !inQuietHours(weeknight, at(2026, 6, 7, 6, 0)));

// ── disabled / malformed / degenerate fail open (never silently mute) ─────────────
check("disabled = not quiet", !inQuietHours({ ...day, enabled: false }, at(2026, 6, 1, 12, 0)));
check("undefined = not quiet", !inQuietHours(undefined, at(2026, 6, 1, 12, 0)));
check("malformed time = not quiet", !inQuietHours({ enabled: true, start: "9", end: "oops" }, at(2026, 6, 1, 12, 0)));
check("zero-length window = not quiet", !inQuietHours({ enabled: true, start: "09:00", end: "09:00" }, at(2026, 6, 1, 9, 0)));
check("empty days = every day", inQuietHours({ ...night, days: [] }, at(2026, 6, 7, 6, 0)));

// ── suppresses (event-aware, allowUrgent) ─────────────────────────────────────────
const t = at(2026, 6, 1, 23, 30); // inside `night`
check("suppresses done during quiet", suppresses(night, "done", t));
check("suppresses error during quiet (default)", suppresses(night, "error", t));
check("does not suppress outside quiet", !suppresses(night, "done", at(2026, 6, 1, 12, 0)));
const urgent: QuietHours = { ...night, allowUrgent: true };
check("allowUrgent lets error through", !suppresses(urgent, "error", t));
check("allowUrgent still suppresses non-error", suppresses(urgent, "done", t));

// ── describeQuietHours ────────────────────────────────────────────────────────────
check("describe off when disabled", describeQuietHours(undefined) === "off");
check("describe everyday window", describeQuietHours(night) === "22:00–07:00 · every day");
check(
  "describe weekdays + urgent",
  describeQuietHours({ ...weeknight, allowUrgent: true }) === "22:00–07:00 · Mon, Tue, Wed, Thu, Fri · errors still alert",
);

// ── Notifier integration: a fixed clock inside quiet hours suppresses delivery ─────
const hook: WebhookConfig = {
  id: "w1",
  name: "test",
  url: "https://example.com/hook",
  format: "json",
  createdAt: 0,
  updatedAt: 0,
};
const ctx: NotifyContext = { id: "s1", label: "fix login", cwd: "/x", goal: "g", status: "done", turns: 3, elapsedMin: 5 };

(async () => {
  const calls: string[] = [];
  const post = async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200 };
  };

  // Quiet → no delivery.
  const quiet = new Notifier(() => [hook], post, () => {}, () => night, () => t);
  const nQuiet = await quiet.fire("done", ctx);
  check("notifier: quiet hours suppress delivery (count 0)", nQuiet === 0);
  check("notifier: no POST attempted while quiet", calls.length === 0);

  // Awake → delivers.
  const awake = new Notifier(() => [hook], post, () => {}, () => night, () => at(2026, 6, 1, 12, 0));
  const nAwake = await awake.fire("done", ctx);
  check("notifier: outside quiet delivers (count 1)", nAwake === 1);
  check("notifier: one POST attempted while awake", calls.length === 1);

  // Quiet + allowUrgent → error still delivers.
  calls.length = 0;
  const urgentN = new Notifier(() => [hook], post, () => {}, () => urgent, () => t);
  const nErr = await urgentN.fire("error", ctx);
  check("notifier: allowUrgent delivers error during quiet", nErr === 1 && calls.length === 1);
  const nDone = await urgentN.fire("done", ctx);
  check("notifier: allowUrgent still suppresses non-error", nDone === 0);

  console.log(`\n[quiethours] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
  process.exit(pass ? 0 : 1);
})();

/**
 * Typed layer over the Store key/value preferences, holding the learning loop's
 * artifacts: versioned operator profiles, the active-version pointer (revert =
 * one write), pending drafts, and the example bank. Immutable, append-only
 * version snapshots; nothing is ever deleted.
 *
 * Key layout (value = JSON):
 *   profile.active.<scope>           ActiveProfileRef
 *   profile.version.<scope>#<n>      OperatorProfile   (n = 1-based version)
 *   profile.draft.<scope>            DraftProposal
 *   examplebank.<scope>              ExampleBank
 */
import type { Store } from "../db/store.js";
import {
  GLOBAL_SCOPE,
  type ActiveProfileRef,
  type DraftProposal,
  type ExampleBank,
  type ExampleBankItem,
  type OperatorProfile,
  type ProfileScope,
} from "./types.js";

const activeKey = (s: ProfileScope) => `profile.active.${s}`;
const versionPrefix = (s: ProfileScope) => `profile.version.${s}#`;
const versionKey = (s: ProfileScope, n: number) => `profile.version.${s}#${n}`;
const draftKey = (s: ProfileScope) => `profile.draft.${s}`;
const bankKey = (s: ProfileScope) => `examplebank.${s}`;

function parse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class ProfileStore {
  constructor(private readonly store: Store) {}

  // ---- active ref + versions ----------------------------------------------

  getActiveRef(scope: ProfileScope): ActiveProfileRef | null {
    return parse<ActiveProfileRef>(this.store.getPreference(activeKey(scope))?.value);
  }

  getVersion(scope: ProfileScope, version: number): OperatorProfile | null {
    return parse<OperatorProfile>(this.store.getPreference(versionKey(scope, version))?.value);
  }

  getActive(scope: ProfileScope): OperatorProfile | null {
    const ref = this.getActiveRef(scope);
    return ref ? this.getVersion(scope, ref.version) : null;
  }

  listVersions(scope: ProfileScope): OperatorProfile[] {
    return this.store
      .listPreferences(versionPrefix(scope))
      .map((r) => parse<OperatorProfile>(r.value))
      .filter((p): p is OperatorProfile => !!p)
      .sort((a, b) => a.version - b.version);
  }

  private nextVersion(scope: ProfileScope): number {
    const vs = this.store.listPreferences(versionPrefix(scope));
    let max = 0;
    for (const r of vs) {
      const n = Number(r.key.slice(versionPrefix(scope).length));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
  }

  /** Snapshot a profile body as a new version and point the active ref at it. */
  saveVersionAndActivate(body: Omit<OperatorProfile, "version" | "createdAt">): OperatorProfile {
    const version = this.nextVersion(body.scope);
    const profile: OperatorProfile = { ...body, version, createdAt: Date.now() };
    this.store.setPreference(versionKey(body.scope, version), JSON.stringify(profile), body.scope);
    this.activateVersion(body.scope, version);
    return profile;
  }

  /** Repoint the active ref to an existing version (this is "revert"). */
  activateVersion(scope: ProfileScope, version: number): void {
    if (!this.getVersion(scope, version)) throw new Error(`no version ${version} for scope ${scope}`);
    const ref: ActiveProfileRef = { scope, version, activatedAt: Date.now() };
    this.store.setPreference(activeKey(scope), JSON.stringify(ref), scope);
  }

  // ---- drafts -------------------------------------------------------------

  getDraft(scope: ProfileScope): DraftProposal | null {
    return parse<DraftProposal>(this.store.getPreference(draftKey(scope))?.value);
  }

  saveDraft(draft: DraftProposal): void {
    this.store.setPreference(draftKey(draft.scope), JSON.stringify(draft), draft.scope);
  }

  clearDraft(scope: ProfileScope): void {
    this.store.deletePreference(draftKey(scope));
  }

  // ---- example bank -------------------------------------------------------

  getExampleBank(scope: ProfileScope): ExampleBank {
    return (
      parse<ExampleBank>(this.store.getPreference(bankKey(scope))?.value) ?? {
        schema: 1,
        scope,
        items: [],
        updatedAt: Date.now(),
      }
    );
  }

  /** Merge items into the bank: dedupe by hash (bump count + recency), ring-cap. */
  appendExamples(scope: ProfileScope, items: ExampleBankItem[], cap = 200): void {
    if (items.length === 0) return;
    const bank = this.getExampleBank(scope);
    const byHash = new Map(bank.items.map((it) => [it.hash, it]));
    for (const it of items) {
      const existing = byHash.get(it.hash);
      if (existing) {
        existing.count += it.count;
        existing.lastSeen = Math.max(existing.lastSeen, it.lastSeen);
      } else {
        byHash.set(it.hash, { ...it });
      }
    }
    // Keep the most-seen, most-recent items up to the cap.
    const merged = [...byHash.values()]
      .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
      .slice(0, cap);
    const next: ExampleBank = { schema: 1, scope, items: merged, updatedAt: Date.now() };
    this.store.setPreference(bankKey(scope), JSON.stringify(next), scope);
  }

  // ---- scope discovery (for the dashboard summary) ------------------------

  /** Per-project scopes that have any version or active ref recorded. */
  listProjectScopes(): ProfileScope[] {
    const scopes = new Set<ProfileScope>();
    for (const prefix of ["profile.active.cwd:", "profile.version.cwd:"]) {
      for (const r of this.store.listPreferences(prefix)) {
        // key = "profile.<active|version>.cwd:<abs>[#n]"; recover "cwd:<abs>"
        const afterKind = r.key.replace(/^profile\.(active|version)\./, "");
        const scope = afterKind.split("#")[0];
        if (scope && scope !== GLOBAL_SCOPE) scopes.add(scope);
      }
    }
    return [...scopes];
  }
}

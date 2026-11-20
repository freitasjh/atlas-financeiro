// gate-write-scope.spec.mjs — SEC-DEBT-39 contraprova for the qa-engineer
// write-scope gate (GATE-05, I5/I9).
//
// Bug: normalizePath stripped the leading "/" from an absolute path, so
// isHarnessScoped saw "home/.../harness/x" and denied a legitimate report
// write. The fix resolves absolute paths against REPO_ROOT before scoping.
//
// Tests use the real REPO_ROOT (imported, never hardcoded) so the suite stays
// portable across checkouts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  DenyError,
  checkWriteAccess,
  isHarnessScoped,
  isProtectedPath,
  normalizePath,
  toRepoRelative,
} from "../gate.js";
import { REPO_ROOT, loadHarnessConfig } from "../lib/config.mjs";

const repoPath = (...parts) => join(REPO_ROOT, ...parts);
const config = loadHarnessConfig();
const PROTECTED = config?.protectedPaths ?? [];

function deniedReason(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof DenyError, `expected DenyError, got ${err?.name}: ${err?.message}`);
    return err.reason;
  }
  return null;
}

describe("qa-engineer write scope (absolute paths)", () => {
  it("when absolute edit inside repo harness_then allows", () => {
    const reason = deniedReason(() =>
      checkWriteAccess({
        agent: "qa-engineer",
        tool: "edit",
        targets: [{ kind: "path", path: repoPath("harness", "h3-final-report.md") }],
        protectedPaths: PROTECTED,
      }),
    );
    assert.equal(reason, null, `denied with ${reason}`);
  });

  it("when absolute write inside repo harness subdir_then allows", () => {
    const reason = deniedReason(() =>
      checkWriteAccess({
        agent: "qa-engineer",
        tool: "write",
        targets: [{ kind: "path", path: repoPath("harness", "h3-final-89", "probe.txt") }],
        protectedPaths: PROTECTED,
      }),
    );
    assert.equal(reason, null, `denied with ${reason}`);
  });

  it("when relative write inside harness_then allows", () => {
    const reason = deniedReason(() =>
      checkWriteAccess({
        agent: "qa-engineer",
        tool: "write",
        targets: [{ kind: "path", path: "harness/h3-final-report.md" }],
        protectedPaths: PROTECTED,
      }),
    );
    assert.equal(reason, null, `denied with ${reason}`);
  });

  it("when absolute write into src_then denies qa-scope", () => {
    const reason = deniedReason(() =>
      checkWriteAccess({
        agent: "qa-engineer",
        tool: "write",
        targets: [{ kind: "path", path: repoPath("src", "x.ts") }],
        protectedPaths: PROTECTED,
      }),
    );
    assert.equal(reason, "qa-scope-violation");
  });

  it("when absolute write outside repo with harness segment_then denies qa-scope", () => {
    const reason = deniedReason(() =>
      checkWriteAccess({
        agent: "qa-engineer",
        tool: "write",
        targets: [{ kind: "path", path: "/tmp/evil/harness/x" }],
        protectedPaths: PROTECTED,
      }),
    );
    assert.equal(reason, "qa-scope-violation");
  });

  it("when qa-engineer targets harness.config.json_then denies", () => {
    const reason = deniedReason(() =>
      checkWriteAccess({
        agent: "qa-engineer",
        tool: "write",
        targets: [{ kind: "path", path: repoPath("harness.config.json") }],
        protectedPaths: PROTECTED,
      }),
    );
    assert.equal(reason, "protected-path-write");
  });
});

describe("isHarnessScoped evidence root", () => {
  it("when evidencePath is evidence/_then accepts evidence and rejects harness", () => {
    assert.equal(isHarnessScoped(repoPath("evidence", "r.json"), "evidence/"), true);
    assert.equal(isHarnessScoped(repoPath("harness", "r.json"), "evidence/"), false);
  });

  it("when default root_then keeps harness.config.json out of scope", () => {
    assert.equal(isHarnessScoped("harness/a.md"), true);
    assert.equal(isHarnessScoped("harness.config.json"), false);
  });
});

describe("path helpers", () => {
  it("when normalizing variants_then keeps posix relative form", () => {
    assert.equal(normalizePath("./harness//x"), "harness//x");
    assert.equal(normalizePath("harness\\h3.md"), "harness/h3.md");
    assert.equal(normalizePath("harness/a.md"), "harness/a.md");
  });

  it("when absolute path is inside repo_then toRepoRelative strips the root", () => {
    assert.equal(toRepoRelative(repoPath("harness", "h3.md")), "harness/h3.md");
  });

  it("when absolute path escapes repo_then toRepoRelative keeps normalized fallback", () => {
    assert.equal(toRepoRelative("/tmp/evil/harness/x"), "tmp/evil/harness/x");
  });

  it("when protected path is absolute_then isProtectedPath still matches", () => {
    assert.equal(isProtectedPath(repoPath(".opencode", "plugins", "gate.js"), PROTECTED), true);
  });
});

describe("role regressions", () => {
  it("when orchestrator writes absolute workflow-state_then allows", () => {
    const reason = deniedReason(() =>
      checkWriteAccess({
        agent: "orchestrator",
        tool: "write",
        targets: [{ kind: "path", path: repoPath("workflow-state.json") }],
        protectedPaths: PROTECTED,
      }),
    );
    assert.equal(reason, null, `denied with ${reason}`);
  });

  it("when code-reviewer writes anywhere_then denies role-write", () => {
    const reason = deniedReason(() =>
      checkWriteAccess({
        agent: "code-reviewer",
        tool: "write",
        targets: [{ kind: "path", path: repoPath("harness", "x.md") }],
        protectedPaths: PROTECTED,
      }),
    );
    assert.equal(reason, "write-denied-for-role");
  });
});

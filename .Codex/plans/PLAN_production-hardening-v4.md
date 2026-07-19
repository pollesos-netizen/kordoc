# Implementation Plan: kordoc v4 Production Hardening

**Status**: Complete  
**Started**: 2026-07-11 | **Last Updated**: 2026-07-11  
**Plan Size**: Large (6 phases)

## Critical Instructions

After each phase:
1. Check off completed tasks.
2. Run the phase quality gate.
3. Do not continue with failing checks.
4. Record material findings in Notes.

## Overview

Fix the production-review defects found in the 2026-07-10~11 change range: unsafe public inputs, stale plugin delivery, real-document preset mismatches, HWPX structural inconsistencies, and missing release gates.

### Success Criteria

- [x] Public API/CLI/MCP inputs cannot create malformed XML or `NaN` geometry.
- [x] The bundled plugin installs and documents kordoc v4.
- [x] Official/plan/notice defaults match the measured real-document corpus or expose an explicit variant.
- [x] Cover/TOC behavior is implemented as advertised; title bars render at declared height.
- [x] Wrapped orphan captions and multiline/nested HTML tables preserve content and geometry.
- [x] Build, tests, type check, bench gate, package audit, and Hancom render checks pass.

## Architecture Decisions

| Decision | Rationale | Trade-off |
|---|---|---|
| Central runtime validation for generator options | Library, CLI, and MCP must share safe behavior | Invalid inputs become explicit errors |
| Escape all dynamic XML attribute values at the serialization boundary | Prevent malformed XML and attribute injection | None |
| Use corpus-backed preset defaults | “Official” should reflect dominant operational documents | Existing output geometry changes |
| Keep changes surgical inside existing modules | Minimize regression surface | Some legacy structure remains |
| Preserve review-only dependencies unless an audit fix is available | Avoid unrelated upgrades | Residual advisories may require upstream action |

## Test Strategy

- Unit: option validation, XML escaping, marker/default resolution, caption traversal, table height math.
- Integration: CLI error exits, seven preset generation/validation/parse, plugin command metadata.
- E2E: actual Hancom rendering of report title box plus corpus benchmark gates.

## Phases

### Phase 1: Input and XML Safety

- [x] RED: tests for font names containing `&`, `"`, `<`.
- [x] RED: CLI/API tests for non-finite/invalid point size, line spacing, margins, and approval counts.
- [x] GREEN: central option validation and XML attribute escaping.
- [x] REFACTOR: reuse validation across CLI/MCP/library.
- Quality gate: targeted tests + malformed-XML reproduction eliminated.

### Phase 2: Plugin and Release Metadata

- [x] RED: metadata tests/assertions for package, lock, plugin, and command major version.
- [x] GREEN: update plugin manifest/skill commands and package-lock root version.
- [x] REFACTOR: document all seven presets and v4 flags.
- Quality gate: plugin contains no `kordoc@^3`; package dry-run reports consistent version.

### Phase 3: Corpus-backed Presets

- [x] RED: tests for official body default, plan numbering, and notice bullet behavior.
- [x] GREEN: apply measured defaults or explicit variants with backward-compatible overrides.
- [x] REFACTOR: align comments, changelog, README, CLI/MCP descriptions.
- Quality gate: preset tests + representative corpus comparisons.

### Phase 4: HWPX Structure and Rendering

- [x] RED: non-gaejosik cover/TOC, title-bar height, ctrl-wrapped caption, multiline/nested HTML table height.
- [x] GREEN: implement each missing structural path.
- [x] REFACTOR: share small spacer style and row-height calculations.
- Quality gate: targeted generation/parser tests and validateHwpx.

### Phase 5: Type, Security, and Hancom Gate

- [x] Fix newly introduced type regression and safely reduce existing type failures in touched code.
- [x] Upgrade fixable production dependencies without unrelated changes.
- [x] Run `npm audit --omit=dev --audit-level=high`.
- [x] Render representative outputs in Hancom and compare geometry.
- Quality gate: type/build/audit/manual render evidence.

### Phase 6: Fresh-context Verification

- [x] Independent verification agent runs type, test, build, bench, package, and E2E checks.
- [x] Review final diff for surgical scope and clean worktree expectations.
- [x] Complete this plan and report residual risks.

## Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Preset default changes alter existing output | High | Medium | Preserve explicit overrides and add release notes |
| Hancom rendering differs from XML geometry | Medium | High | Actual app render before completion |
| Dependency fixes require major updates | Medium | Medium | Prefer patched compatible ranges; report upstream blockers |
| Visual baseline is stale | High | Medium | Inspect fresh captures; do not auto-update baseline without human-readable evidence |

## Rollback

Each phase is isolated by file group and test suite. Revert only the phase-specific changes; never reset the worktree or discard unrelated user changes.

## Notes

- Initial review evidence: 911 tests pass, but production is blocked by P1/P2 defects and release metadata drift.
- Local measured corpus: 104 Seoul approvals, 34 press releases, 10 notices, 8 report/plan references.
- Phase 1: XML font attribute escaping, finite/range checks, and approval maximum 6 verified by targeted tests.
- Phase 2: package/lock/plugin versions aligned at 4.0.2; plugin commands now pin major v4 and list seven presets.
- Phase 3: official default 12pt (64/104 dominant); plan defaults to measured □→ㅇ→* hierarchy. Non-majority font/page-number variants were not forced.
- Phase 4: explicit cover/TOC works outside gaejosik, 382HU title bars use a 1pt spacer, wrapped captions survive, and HTML table hp:sz follows expanded rows.
- Phase 5: TypeScript has 0 errors, 919 tests/build/bench pass, production audit has 0 vulnerabilities, package dry-run is 4.0.2, and Hancom renders report title bars, cover/TOC, official 12pt body, and 10pt approval labels correctly.
- The visual harness now captures an exact unique Hancom window without closing the user's session; the inspected report baseline was updated from the stale thick-bar render and passes at hamming distance 0.

- Phase 6 (2026-07-11, fresh-context agent): tsc 0 errors, 919/919 tests, tsup build, bench:gate 6-chain (reflow 93% ≥ 90%, doc gate 55/59), pack dry-run 4.0.2 (75 files), no `kordoc@^3` in plugins, versions aligned at 4.0.2 (package/lock root+packages[""]/plugin), production audit 0 vulnerabilities — ALL GREEN.
- Final diff review: 29 files, +431/−236, all changes map to Phases 1–5; type fixes are xmldom Document casts plus pre-existing missing WarningCodes (COM_EMPTY/DRM_COM_FALLBACK) used by com-fallback.ts. Dependency bumps are minor-range (xmldom 0.9.10, markdown-it 14.3.0, MCP SDK 1.29.0). Visual baseline hash refreshed with improved unique-window capture harness.
- Residual risks: (1) prepublishOnly has no visual gate — intentional per CLAUDE.md (macOS GUI-only, manual once before publish); rerun `npm run bench:visual` before the actual npm publish. (2) official preset default 12pt and plan preset □→ㅇ→* change existing output geometry — release notes must call this out. (3) Changes are uncommitted; commit/release is a separate user decision.

**Next Action**: None — plan complete.

**Post-plan (2026-07-11, second production review + release)**: An 8-angle finder / 7-verifier adversarial review over the hardened diff confirmed 8 additional defects (bodyFont lost with cover/toc on non-measured presets — two emission paths; h4>h3 inversion at ≤13pt; cell object-caption misattribution + false UNSUPPORTED_ELEMENT warnings; press+cover subtitle loss; bodyTitleBox flipping rich assets; approval label 70% line spacing vs measured 100%) plus cleanups (usesAsteriskThird helper, AXCloseButton window cleanup, doc updates). All fixed with 7 new regression tests. Released as **v4.0.3**: commit edaaa81 → main, tag v4.0.3, npm kordoc@4.0.3=latest (visual gate re-baselined for committed v4 table/colPr changes, 8/8 hamming 0).

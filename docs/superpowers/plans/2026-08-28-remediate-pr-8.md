# PR #8 Remediation Plan: System Prompt Patches for Claude Code 2.1.246

- **Goal:** Fix code review findings in PR #8 (remove hardcoded user paths and update default fallback version) and verify patch application.
- **Tech Stack:** Node.js, Bash, LIEF.
- **Spec Reference:** PR #8 Review Comments.

---

### Task 1: Fix Hardcoded Path in `patch-native.sh`

- **Target files:** `system-prompt/2.1.246/patch-native.sh`
- **Consumes / Produces:** Shell script execution environment
- **Step 1:** Verify presence of `/Users/gus/` in `patch-native.sh`.
- **Step 2:** Check with `grep "/Users/gus" system-prompt/2.1.246/patch-native.sh` (fails clean check).
- **Step 3:** Replace `/Users/gus` with `$HOME`.
- **Step 4:** Re-run grep to confirm zero occurrences.
- **Step 5:** Git commit: `git commit -m "fix(system-prompt): replace hardcoded user path with $HOME in patch-native.sh"`

---

### Task 2: Update Default Binary Path Fallback in `native-extract.js`

- **Target files:** `system-prompt/2.1.246/native-extract.js`
- **Consumes / Produces:** Node.js CLI script
- **Step 1:** Verify presence of `2.1.17` in `native-extract.js:L152`.
- **Step 2:** Check with `grep "2.1.17" system-prompt/2.1.246/native-extract.js`.
- **Step 3:** Update default fallback path to `2.1.246`.
- **Step 4:** Re-run verification to confirm `2.1.246` is present.
- **Step 5:** Git commit: `git commit -m "fix(system-prompt): update default version fallback to 2.1.246 in native-extract.js"`

---

### Task 3: Full End-to-End Verification of System Prompt Patches

- **Target files:** `system-prompt/2.1.246/*`
- **Step 1:** Run `node system-prompt/2.1.246/patch-cli.js system-prompt/2.1.246/cli.js`.
- **Step 2:** Verify 48/48 patches apply cleanly with 0 errors / skips.
- **Step 3:** Clean up temporary files (`rm -f system-prompt/2.1.246/cli.js`).
- **Step 4:** Verify `node scripts/generate-toc.js` is up to date.

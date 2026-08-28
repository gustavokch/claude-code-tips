---
description: Upgrade system prompt patches to the latest Claude Code version
---

Upgrade system prompt patches to the latest Claude Code version.

Follow the instructions in `.claude/skills/upgrade-patches/SKILL.md`:

1. Resolve target version (from argument or `claude --version` / npm).
2. Scaffold `system-prompt/<VERSION>` from latest existing version.
3. Locate/download native binary.
4. Extract `cli.js` & compute SHA-256 hash.
5. Reconcile & verify prompt patches until 100% pass.
6. Synchronize tweakcc hashes & config.
7. Repack, re-sign, and test native binary.
8. Branch, commit, push, and create PR.

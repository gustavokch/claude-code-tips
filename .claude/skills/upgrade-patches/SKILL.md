---
name: upgrade-patches
description: Automatically upgrade system prompt patches, native Mach-O binary repack, and tweakcc hashes for a new Claude Code version.
---

# Upgrade System Prompt Patches for Claude Code

Automatically port, adapt, test, and package system prompt patches for a new Claude Code release.

## Workflow Overview

```
1. Resolve Target Version
2. Scaffold system-prompt/<VERSION> from latest existing version
3. Locate / Download Native Binary
4. Extract cli.js & Compute SHA-256 Hash
5. Reconcile & Verify System Prompt Patches (100% pass)
6. Synchronize tweakcc Hashes & Config
7. Repack, Re-sign, and Test Native Binary
8. Branch, Commit, Push, and Create PR
```

---

## Step 1: Resolve Target Version

Determine target version:
- If user provides version as argument: use `$ARG` (e.g. `2.1.246`).
- Else check installed version: `claude --version | awk '{print $1}'`.
- Or check upstream registry: `npm view @anthropic-ai/claude-code version`.

Find latest existing version directory in `system-prompt/`:

```bash
LATEST_EXISTING=$(ls -d system-prompt/2.* | sort -V | tail -1 | xargs basename)
echo "Latest existing patch directory: $LATEST_EXISTING"
```

If `system-prompt/$TARGET_VERSION` already exists and is fully verified, ask user if they want to re-verify or force re-scaffold.

---

## Step 2: Scaffold `system-prompt/<TARGET_VERSION>`

Copy files from `$LATEST_EXISTING` to `system-prompt/$TARGET_VERSION`:

```bash
TARGET_DIR="system-prompt/$TARGET_VERSION"
cp -r "system-prompt/$LATEST_EXISTING" "$TARGET_DIR"
rm -f "$TARGET_DIR/cli.js" "$TARGET_DIR/cli.js.backup"
```

Update version references in scripts:
- `patch-cli.js`: `const EXPECTED_VERSION = '$TARGET_VERSION';`
- `backup-cli.sh`: `EXPECTED_VERSION="$TARGET_VERSION"`
- `restore-cli.sh`: `EXPECTED_VERSION="$TARGET_VERSION"`
- `patch-native.sh`: default binary path to `~/.local/share/claude/versions/$TARGET_VERSION`

---

## Step 3: Locate / Download Native Binary

Locate target binary on macOS arm64:

```bash
BIN_PATH="$HOME/.local/share/claude/versions/$TARGET_VERSION"
```

If binary does not exist locally at that path, download it via official GCS manifest:

```bash
MANIFEST_URL="https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/${TARGET_VERSION}/manifest.json"
BIN_URL="https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/${TARGET_VERSION}/darwin-arm64/claude"

mkdir -p "$(dirname "$BIN_PATH")"
curl -sL "$BIN_URL" -o "$BIN_PATH"
chmod 755 "$BIN_PATH"
```

---

## Step 4: Extract `cli.js` & Compute SHA-256 Hash

Ensure `NODE_PATH` points to `node-lief` if needed:

```bash
if [ -d "$HOME/.npm/_npx/f44a4ca36ad91b43/node_modules" ]; then
  export NODE_PATH="$HOME/.npm/_npx/f44a4ca36ad91b43/node_modules:${NODE_PATH}"
fi
```

Extract the bundle chunk containing the core CLI and system prompts (e.g. `_444.js`):

```bash
node "$TARGET_DIR/native-extract.js" "$BIN_PATH" "$TARGET_DIR/cli.js.backup"
ACTUAL_HASH=$(shasum -a 256 "$TARGET_DIR/cli.js.backup" | cut -d' ' -f1)
echo "Extracted cli.js SHA-256: $ACTUAL_HASH"
```

Update:
- `EXPECTED_HASHES['native-macos-arm64'] = '$ACTUAL_HASH'` in `$TARGET_DIR/patch-cli.js`
- `EXPECTED_HASH="$ACTUAL_HASH"` in `$TARGET_DIR/backup-cli.sh`

---

## Step 5: Adapt & Reconcile System Prompt Patches

Test patch application against `$TARGET_DIR/cli.js.backup`:

```bash
node "$TARGET_DIR/patch-cli.js" "$TARGET_DIR/cli.js.backup"
```

For any `[SKIP]` patch:
1. Inspect the patch `.find.txt` in `$TARGET_DIR/patches/`.
2. Compare with prompt definitions in `~/.tweakcc/system-prompts/` or search keywords in `$TARGET_DIR/cli.js.backup`.
3. Update `.find.txt` and `.replace.txt` to match the new AST/syntax. Note: template variables (`${VAR}`) are captured by regex automatically.
4. Rerun `node "$TARGET_DIR/patch-cli.js" "$TARGET_DIR/cli.js.backup"` until **all patches pass with 0 skips**.

---

## Step 6: Synchronize tweakcc Hashes & Config

If tweakcc is installed (`~/.tweakcc`):
1. Update `~/.tweakcc/systemPromptOriginalHashes.json` with baseline MD5s for the target version.
2. Update `~/.tweakcc/systemPromptAppliedHashes.json` with applied MD5s from modified prompt files.
3. Update `~/.tweakcc/config.json`:
   ```json
   {
     "ccVersion": "<TARGET_VERSION>",
     "changesApplied": true,
     "lastModified": <CURRENT_TIMESTAMP>
   }
   ```

---

## Step 7: Repack, Re-sign, and Test Native Binary

If the binary at `$BIN_PATH` is currently running, create a copy for testing:

```bash
TEST_BIN="/tmp/claude-${TARGET_VERSION}-test"
cp "$BIN_PATH" "$TEST_BIN"
bash "$TARGET_DIR/patch-native.sh" "$TEST_BIN"
```

Verify signature and version:

```bash
codesign -v "$TEST_BIN"
"$TEST_BIN" --version
```

Clean up temporary working files:

```bash
rm -f "$TARGET_DIR/cli.js"
```

---

## Step 8: Branch, Commit, Push & Create PR

1. Check out new branch:
   ```bash
   git checkout -b "update-patch-$TARGET_VERSION"
   ```
2. Add files and commit:
   ```bash
   git add "system-prompt/$TARGET_VERSION/"
   git commit -m "feat: add system prompt patches for Claude Code $TARGET_VERSION"
   ```
3. Push branch and create PR using `gh`:
   ```bash
   git push -u origin "update-patch-$TARGET_VERSION"
   gh pr create --title "feat: add system prompt patches for Claude Code $TARGET_VERSION" --body "## Changes
- Add system prompt patches for Claude Code v$TARGET_VERSION
- Update native binary extraction, repack, and hash verification for macOS ARM64
- Reconcile all system prompt patches for v$TARGET_VERSION"
   ```

#!/usr/bin/env node
/**
 * Patch script for Claude Code CLI system prompt
 * Always restores from backup first, then applies patches
 * Supports single file mode and directory mode (for Bun multi-chunk binaries)
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const EXPECTED_VERSION = '2.1.267';
const EXPECTED_HASHES = {
  npm: 'TODO: Update npm hash',
  'native-linux-x64': 'TODO: Update hash',
  'native-linux-arm64': 'TODO: Update hash',
  'native-macos-arm64': 'faf05b0a665b7ebff191698068a733e32b60dc19357ab70998808d381e5e4456',
};

// Unicode characters that native (Bun) builds escape differently
const UNICODE_ESCAPES = [
  ['—', '\\u2014'],  // em-dash —
  ['→', '\\u2192'],  // arrow →
  ['–', '\\u2013'],  // en-dash –
  ['“', '\\u201c'],  // left double quote "
  ['”', '\\u201d'],  // right double quote "
  ['‘', '\\u2018'],  // left single quote '
  ['’', '\\u2019'],  // right single quote '
  ['…', '\\u2026'],  // ellipsis …
];

function toNativeEscapes(str) {
  let result = str;
  for (const [char, escape] of UNICODE_ESCAPES) {
    result = result.split(char).join(escape);
  }
  return result;
}

function findClaudeCli() {
  const home = process.env.HOME;

  try {
    const claudePath = execSync('which claude', { encoding: 'utf8' }).trim();
    const realPath = fs.realpathSync(claudePath);
    const cliPath = path.join(path.dirname(realPath), 'cli.js');
    if (fs.existsSync(cliPath)) return cliPath;
    if (realPath.endsWith('cli.js')) return realPath;
  } catch (e) {}

  const globalLocations = [
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  ];

  for (const loc of globalLocations) {
    if (fs.existsSync(loc)) return loc;
  }

  const localLauncher = path.join(home, '.claude/local/claude');
  if (fs.existsSync(localLauncher)) {
    const content = fs.readFileSync(localLauncher, 'utf8');
    const execMatch = content.match(/exec\s+"([^"]+)"/);
    if (execMatch) {
      return fs.realpathSync(execMatch[1]);
    }
  }

  return null;
}

const customPath = process.argv.slice(2).find(a => !a.startsWith('--'));
const basePath = customPath || findClaudeCli();

if (!basePath) {
  console.error('Error: Could not find Claude Code CLI.');
  process.exit(1);
}

const patchDir = __dirname;

function loadPatch(name) {
  const findPath = path.join(patchDir, 'patches', `${name}.find.txt`);
  const replacePath = path.join(patchDir, 'patches', `${name}.replace.txt`);
  if (fs.existsSync(findPath) && fs.existsSync(replacePath)) {
    return {
      find: fs.readFileSync(findPath, 'utf8'),
      replace: fs.readFileSync(replacePath, 'utf8')
    };
  }
  return null;
}

function createRegexPatch(find, replace) {
  const varRegex = /\$\{[a-zA-Z0-9_.$]+(?:\([a-zA-Z0-9_.$]*\)(?:\/\d+)?)?\}|\$\{VAR\d+\}/g;
  const identRegex = /__[A-Z0-9_]+__/g;

  const placeholders = [];
  const seenPlaceholders = new Set();

  let match;
  while ((match = varRegex.exec(find)) !== null) {
    if (!seenPlaceholders.has(match[0])) {
      seenPlaceholders.add(match[0]);
      placeholders.push({ text: match[0], type: 'var' });
    }
  }

  while ((match = identRegex.exec(find)) !== null) {
    if (!seenPlaceholders.has(match[0])) {
      seenPlaceholders.add(match[0]);
      placeholders.push({ text: match[0], type: 'ident' });
    }
  }

  if (placeholders.length === 0) return null;

  let regexStr = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const p of placeholders) {
    const escaped = p.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const capture = p.type === 'var' ? '(\\$\\{[\\s\\S]+?\\})' : '([a-zA-Z0-9_$]+)';
    regexStr = regexStr.split(escaped).join(capture);
  }

  let replaceStr = replace;
  for (let i = 0; i < placeholders.length; i++) {
    replaceStr = replaceStr.split(placeholders[i].text).join(`$${i + 1}`);
  }

  return {
    regex: new RegExp(regexStr),
    replace: replaceStr,
    varCount: placeholders.length
  };
}

const patches = [
  // Big wins (1KB+)
  { name: 'Slim TodoWrite examples (6KB → 0.4KB)', file: 'todowrite-examples' },
  { name: 'Simplify git commit section (~3.4KB)', file: 'git-commit' },
  { name: 'Slim Bash tool description (3.7KB → 0.6KB)', file: 'bash-tool' },
  { name: 'Simplify PR creation section (~1.7KB)', file: 'pr-creation' },
  { name: 'Slim EnterPlanMode When to Use (1.2KB → 200 chars)', file: 'enterplanmode-when-to-use' },
  { name: 'Slim TodoWrite states section (1.8KB → 0.4KB)', file: 'todowrite-states' },
  { name: 'Slim Skill tool instructions (887 → 80 chars)', file: 'skill-tool' },
  { name: 'Slim TodoWrite When to Use (1.2KB → 200 chars)', file: 'todowrite-when-to-use' },

  // Medium wins (200-1000 chars)
  { name: 'Slim over-engineering bullets (~900 → 200 chars)', file: 'over-engineering' },
  { name: 'Slim LSP tool description (~750 → 150 chars)', file: 'lsp-tool' },
  { name: 'Slim Edit tool description (~900 → 200 chars)', file: 'edit-tool' },
  { name: 'Slim EnterPlanMode examples (670 → 150 chars)', file: 'enterplanmode-examples' },
  { name: 'Slim EnterPlanMode What Happens (~400 → 120 chars)',
    customRegex: /## What Happens in Plan Mode[\s\S]*?Use (\$\{[^}]+\}) if you need to clarify approaches\n6\. Exit plan mode with (\$\{[^}]+\}) when ready to implement\n\n`/,
    customReplace: '## What Happens in Plan Mode\n\nExplore codebase, design approach, present plan for approval. Use $1 to clarify, $2 when ready.\n\n`' },
  { name: 'Slim ExitPlanMode description (~1.5KB → 200 chars)', file: 'exitplanmode' },
  { name: 'Slim Grep tool description (~715 → 350 chars)', file: 'grep-tool' },
  { name: 'Slim TodoWrite examples v2 (~400 chars)', file: 'todowrite-examples-v2' },
  { name: 'Slim claude-code-guide agent (~500 → 115 chars)', file: 'agent-claude-code-guide' },
  { name: 'Slim NotebookEdit (~510 → 100 chars)', file: 'notebookedit' },
  { name: 'Slim Write tool description (~550 → 100 chars)', file: 'write-tool' },
  { name: 'Slim WebSearch CRITICAL section (485 → 100 chars)', file: 'websearch-critical' },
  { name: 'Slim BashOutput (~440 → 95 chars)', file: 'bashoutput' },
  { name: 'Remove Code References section (363 chars)', file: 'code-references' },
  { name: 'Further slim git commit (~400 → 200 chars)', file: 'git-commit-v2' },
  { name: 'Slim Explore agent (~350 → 120 chars)', file: 'agent-explore' },
  { name: 'Slim security warning (~430 → 120 chars)', file: 'security-warning' },
  { name: 'Further slim PR creation (~400 → 150 chars)', file: 'pr-creation-v2' },
  { name: 'Slim AskUserQuestion (~450 → 190 chars)', file: 'askuserquestion' },
  { name: 'Slim Bash.description param (~300 → 40 chars)', file: 'bash-description-param' },
  { name: 'Slim hooks instruction (~380 → 110 chars)', file: 'hooks-instruction' },
  { name: 'Slim Grep -A/-B/-C context params (~300 → 100 chars)', file: 'grep-params-context' },
  { name: 'Slim KillShell (~260 → 35 chars)', file: 'killshell' },
  { name: 'Slim Glob.path param (~255 → 65 chars)', file: 'glob-path-param' },
  { name: 'Slim Task tool intro (4.1KB → 0.6KB)',
    customRegex: /`\$\{([a-zA-Z0-9_$]+)\}\. Each agent type has specific capabilities and tools available to it\.\n\nAvailable agent types are listed in <system-reminder> messages in the conversation\.\$\{([a-zA-Z0-9_$]+)\}\n\n\$\{[\s\S]*?general-purpose agent is used\.\":([a-zA-Z0-9_$]+)\}`\}`/,
    customReplace: '`Launch agents for complex, multi-step tasks. Specify subagent_type parameter.${$2}`' },
  { name: 'Slim Task tool when-not-to-use', file: 'task-tool-whennot' },
  { name: 'Slim Grep output_mode param (227 → 70 chars)', file: 'grep-params-output_mode' },
  { name: 'Slim Grep head_limit param (232 → 30 chars)', file: 'grep-params-head_limit' },
  { name: 'Slim doing tasks intro (~230 → 30 chars)', file: 'doing-tasks-intro' },
  { name: 'Slim CLI format instruction (~230 → 35 chars)', file: 'cli-format-instruction' },
  { name: 'Slim system-reminder instruction (~280 → 90 chars)', file: 'system-reminder-instruction' },
  { name: 'Slim output text instruction (~230 → 60 chars)', file: 'output-text-instruction' },
  { name: 'Slim URL warning (~220 → 70 chars)', file: 'url-warning' },
  { name: 'Slim security vulnerabilities (~200 → 60 chars)', file: 'security-vulnerabilities' },
  { name: 'Slim Plan agent (~210 → 85 chars)', file: 'agent-plan' },
  { name: 'Slim Grep offset param (135 → 35 chars)', file: 'grep-params-offset' },
  { name: 'Slim Grep type param (114 → 30 chars)', file: 'grep-params-type' },
  { name: 'Slim todos mark complete (~150 → 45 chars)', file: 'todos-mark-complete' },

  // New patches
  { name: 'Slim TaskUpdate description (~1.8KB → 150 chars)', file: 'taskupdate' },
  { name: 'Slim TaskList description (~1.2KB → 90 chars)', file: 'tasklist' },
];

function sha256(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filepath) {
  return sha256(fs.readFileSync(filepath));
}

function computeDirHash(dirPath) {
  const manifestPath = path.join(dirPath, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.combinedSha256) return manifest.combinedSha256;
  }
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.js')).sort();
  const buffers = files.map(f => fs.readFileSync(path.join(dirPath, f)));
  return sha256(Buffer.concat(buffers));
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function main() {
  console.log('Claude Code CLI Patcher');
  console.log('=======================\n');

  const isDirectory = fs.statSync(basePath).isDirectory();
  const backupPath = basePath + '.backup';

  if (!fs.existsSync(backupPath)) {
    console.error(`Error: No backup found at ${backupPath}`);
    process.exit(1);
  }

  const backupHash = isDirectory ? computeDirHash(backupPath) : sha256File(backupPath);
  const validHashes = Object.values(EXPECTED_HASHES);
  if (!validHashes.includes(backupHash)) {
    console.error('Error: Backup hash mismatch');
    console.error(`Expected one of: ${validHashes.join(', ')}`);
    console.error(`Got:             ${backupHash}`);
    process.exit(1);
  }

  const buildType = Object.entries(EXPECTED_HASHES).find(([, h]) => h === backupHash)?.[0] || 'unknown';
  console.log(`Backup verified (v${EXPECTED_VERSION}, ${buildType} build)`);

  if (isDirectory) {
    copyDirRecursive(backupPath, basePath);
  } else {
    fs.copyFileSync(backupPath, basePath);
  }
  console.log('Restored from backup\n');

  const filesToPatch = isDirectory
    ? fs.readdirSync(basePath).filter(f => f.endsWith('.js')).map(f => ({ name: f, path: path.join(basePath, f) }))
    : [{ name: path.basename(basePath), path: basePath }];

  const fileContents = new Map();
  for (const f of filesToPatch) {
    fileContents.set(f.path, fs.readFileSync(f.path, 'utf8'));
  }

  const maxArg = process.argv.find(a => a.startsWith('--max='));
  const maxPatches = maxArg ? parseInt(maxArg.split('=')[1]) : Infinity;
  if (maxPatches !== Infinity) {
    console.log(`Limiting to first ${maxPatches} patches (bisect mode)\n`);
  }

  let appliedCount = 0;
  let patchIndex = 0;

  for (const patch of patches) {
    if (patchIndex >= maxPatches) {
      console.log(`[STOP] Reached max patches limit (${maxPatches})`);
      break;
    }
    patchIndex++;

    let applied = false;

    for (const [filePath, content] of fileContents.entries()) {
      if (patch.customRegex) {
        if (patch.customRegex.test(content)) {
          fileContents.set(filePath, content.replace(patch.customRegex, patch.customReplace));
          console.log(`[OK] ${patch.name} (custom regex) -> ${path.basename(filePath)}`);
          applied = true;
          break;
        }
        continue;
      }

      let find, replace;
      if (patch.file) {
        const loaded = loadPatch(patch.file);
        if (!loaded) {
          console.log(`[SKIP] ${patch.name} (patch files not found)`);
          break;
        }
        find = loaded.find;
        replace = loaded.replace;
      } else {
        find = patch.find;
        replace = patch.replace;
      }

      const regexPatch = createRegexPatch(find, replace);
      const findNative = toNativeEscapes(find);
      const replaceNative = toNativeEscapes(replace);
      const regexPatchNative = (findNative !== find) ? createRegexPatch(findNative, replaceNative) : null;

      if (regexPatch && regexPatch.regex.test(content)) {
        fileContents.set(filePath, content.replace(regexPatch.regex, regexPatch.replace));
        console.log(`[OK] ${patch.name} (regex, ${regexPatch.varCount} vars) -> ${path.basename(filePath)}`);
        applied = true;
        break;
      } else if (regexPatchNative && regexPatchNative.regex.test(content)) {
        fileContents.set(filePath, content.replace(regexPatchNative.regex, regexPatchNative.replace));
        console.log(`[OK] ${patch.name} (regex+native, ${regexPatchNative.varCount} vars) -> ${path.basename(filePath)}`);
        applied = true;
        break;
      } else if (content.includes(find)) {
        if (patch.replaceAll) {
          fileContents.set(filePath, content.split(find).join(replace));
        } else {
          fileContents.set(filePath, content.replace(find, replace));
        }
        console.log(`[OK] ${patch.name} -> ${path.basename(filePath)}`);
        applied = true;
        break;
      } else if (findNative !== find && content.includes(findNative)) {
        if (patch.replaceAll) {
          fileContents.set(filePath, content.split(findNative).join(replaceNative));
        } else {
          fileContents.set(filePath, content.replace(findNative, replaceNative));
        }
        console.log(`[OK] ${patch.name} (native) -> ${path.basename(filePath)}`);
        applied = true;
        break;
      }
    }

    if (applied) {
      appliedCount++;
    } else {
      console.log(`[SKIP] ${patch.name} (not found)`);
    }
  }

  let totalSizeBefore = 0;
  let totalSizeAfter = 0;

  for (const [filePath, newContent] of fileContents.entries()) {
    const origSize = isDirectory
      ? fs.statSync(path.join(backupPath, path.basename(filePath))).size
      : fs.statSync(backupPath).size;
    totalSizeBefore += origSize;
    fs.writeFileSync(filePath, newContent);
    totalSizeAfter += fs.statSync(filePath).size;
  }

  const newHash = isDirectory ? computeDirHash(basePath) : sha256File(basePath);
  const sizeDiff = totalSizeBefore - totalSizeAfter;

  console.log('\n-----------------------');
  console.log(`Patches applied: ${appliedCount}/${patches.length}`);
  console.log(`Size reduction: ${sizeDiff} bytes`);
  console.log(`New hash: ${newHash}`);
}

main();

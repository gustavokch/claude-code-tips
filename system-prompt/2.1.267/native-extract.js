#!/usr/bin/env node
/**
 * Extract target prompt modules from Claude Code 2.1.267 native binary.
 * Supports multi-chunk Bun code-split architecture.
 * Supports ELF (Linux) and Mach-O (macOS) formats.
 */

const LIEF = require("node-lief");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BUN_TRAILER = Buffer.from("\n---- Bun! ----\n");
const SIZEOF_OFFSETS = 32;
const SIZEOF_STRING_POINTER = 8;
const SIZEOF_MODULE_V1 = 4 * SIZEOF_STRING_POINTER + 4; // 36 bytes (Bun < 1.3.9)
const SIZEOF_MODULE_V2 = 4 * SIZEOF_STRING_POINTER + 4 + 16; // 52 bytes (Bun >= 1.3.9)

function detectModuleSize(modulesListLength) {
  if (modulesListLength % SIZEOF_MODULE_V2 === 0) return SIZEOF_MODULE_V2;
  if (modulesListLength % SIZEOF_MODULE_V1 === 0) return SIZEOF_MODULE_V1;
  return SIZEOF_MODULE_V1;
}

function parseStringPointer(buffer, offset) {
  return { offset: buffer.readUInt32LE(offset), length: buffer.readUInt32LE(offset + 4) };
}

function parseOffsets(buffer) {
  let pos = 0;
  const byteCount = buffer.readBigUInt64LE(pos); pos += 8;
  const modulesPtr = parseStringPointer(buffer, pos); pos += 8;
  const entryPointId = buffer.readUInt32LE(pos); pos += 4;
  const compileExecArgvPtr = parseStringPointer(buffer, pos);
  return { byteCount, modulesPtr, entryPointId, compileExecArgvPtr };
}

function getStringPointerContent(buffer, sp) {
  return buffer.subarray(sp.offset, sp.offset + sp.length);
}

function parseModule(buffer, offset) {
  let pos = offset;
  return {
    name: parseStringPointer(buffer, pos), contents: parseStringPointer(buffer, pos + 8),
    sourcemap: parseStringPointer(buffer, pos + 16), bytecode: parseStringPointer(buffer, pos + 24),
    encoding: buffer.readUInt8(pos + 32), loader: buffer.readUInt8(pos + 33),
    moduleFormat: buffer.readUInt8(pos + 34), side: buffer.readUInt8(pos + 35)
  };
}

function extractBunDataFromSection(sectionData) {
  const bunDataSizeU64 = sectionData.length >= 8 ? Number(sectionData.readBigUInt64LE(0)) : 0;
  const bunDataSizeU32 = sectionData.readUInt32LE(0);

  let headerSize, bunDataSize;
  if (sectionData.length >= 8 && 8 + bunDataSizeU64 <= sectionData.length && 8 + bunDataSizeU64 >= sectionData.length - 4096) {
    headerSize = 8; bunDataSize = bunDataSizeU64;
  } else if (4 + bunDataSizeU32 <= sectionData.length && 4 + bunDataSizeU32 >= sectionData.length - 4096) {
    headerSize = 4; bunDataSize = bunDataSizeU32;
  } else {
    throw new Error("Cannot determine section header format");
  }

  const bunDataContent = sectionData.subarray(headerSize, headerSize + bunDataSize);
  const offsetsStart = bunDataContent.length - SIZEOF_OFFSETS - BUN_TRAILER.length;
  const offsetsBytes = bunDataContent.subarray(offsetsStart, offsetsStart + SIZEOF_OFFSETS);

  return { bunOffsets: parseOffsets(offsetsBytes), bunData: bunDataContent, sectionHeaderSize: headerSize };
}

function extractFromELFOverlay(binary) {
  const overlay = binary.overlay;
  const offsetsStart = overlay.length - 8 - BUN_TRAILER.length - SIZEOF_OFFSETS;
  const offsetsBytes = overlay.subarray(offsetsStart, overlay.length - 8 - BUN_TRAILER.length);
  const bunOffsets = parseOffsets(offsetsBytes);
  const tailDataLen = 8 + BUN_TRAILER.length + SIZEOF_OFFSETS;
  const dataStart = overlay.length - tailDataLen - Number(bunOffsets.byteCount);
  const dataRegion = overlay.subarray(dataStart, overlay.length - tailDataLen);
  const trailerBytes = overlay.subarray(overlay.length - 8 - BUN_TRAILER.length, overlay.length - 8);
  return { bunOffsets, bunData: Buffer.concat([dataRegion, offsetsBytes, trailerBytes]) };
}

function extractFromELFRaw(binaryPath) {
  const buf = fs.readFileSync(binaryPath);
  const trailerIdx = buf.lastIndexOf(BUN_TRAILER);
  if (trailerIdx === -1) throw new Error("Bun trailer not found in binary");
  const offsetsStart = trailerIdx - SIZEOF_OFFSETS;
  const offsetsBytes = buf.subarray(offsetsStart, trailerIdx);
  const bunOffsets = parseOffsets(offsetsBytes);
  const dataStart = offsetsStart - Number(bunOffsets.byteCount);
  const bunData = buf.subarray(dataStart, trailerIdx + BUN_TRAILER.length);
  return { bunOffsets, bunData, dataStartInFile: dataStart };
}

function extractFromELF(binary, binaryPath) {
  if (binary.hasOverlay && binary.overlay.length > 0) {
    return extractFromELFOverlay(binary);
  }
  return extractFromELFRaw(binaryPath);
}

function extractFromMachO(binary) {
  const bunSegment = binary.getSegment("__BUN");
  if (!bunSegment) throw new Error("__BUN segment not found");
  const bunSection = bunSegment.getSection("__bun");
  if (!bunSection) throw new Error("__bun section not found");
  return extractBunDataFromSection(bunSection.content);
}

// Target prompt module criteria for 2.1.267
function isTargetPromptModule(index, name, contentStr) {
  // Direct module names or indices
  if (index === 150 || name.includes("chunk-x9dxwndy") || contentStr.includes("The user asked for more questions")) {
    return true;
  }
  if (index === 184 || name.includes("chunk-0xe3qmyt") || contentStr.includes("Schedule when to resume work in /loop dynamic mode")) {
    return true;
  }
  if (index === 187 || name.includes("chunk-0mtkwcqp") || contentStr.includes("You are Claude Code, Anthropic")) {
    return true;
  }
  if (index === 259 || name.includes("chunk-e55d0yhx") || (contentStr.includes("Committing changes with git") && contentStr.includes("Creating pull requests"))) {
    return true;
  }
  return false;
}

function extractModules(binaryPath) {
  LIEF.logging.disable();
  const binary = LIEF.parse(binaryPath);

  let bunData, bunOffsets;
  if (binary.format === "ELF") {
    ({ bunData, bunOffsets } = extractFromELF(binary, binaryPath));
  } else if (binary.format === "MachO") {
    ({ bunData, bunOffsets } = extractFromMachO(binary));
  } else {
    throw new Error(`Unsupported format: ${binary.format}`);
  }

  const modulesListBytes = getStringPointerContent(bunData, bunOffsets.modulesPtr);
  const moduleSize = detectModuleSize(modulesListBytes.length);
  const modulesCount = Math.floor(modulesListBytes.length / moduleSize);

  const matchedModules = [];
  for (let i = 0; i < modulesCount; i++) {
    const module = parseModule(modulesListBytes, i * moduleSize);
    const moduleName = getStringPointerContent(bunData, module.name).toString("utf-8");
    const moduleContent = getStringPointerContent(bunData, module.contents);
    const contentStr = moduleContent.toString("utf-8");

    if (isTargetPromptModule(i, moduleName, contentStr)) {
      matchedModules.push({
        index: i,
        name: moduleName,
        content: moduleContent,
        sha256: crypto.createHash("sha256").update(moduleContent).digest("hex")
      });
    }
  }

  // Sort by index
  matchedModules.sort((a, b) => a.index - b.index);
  return matchedModules;
}

// Main
const binaryPath = process.argv[2] || `${process.env.HOME}/.local/share/claude/versions/2.1.267`;
const targetPath = process.argv[3] || "/tmp/native-cli.js";

try {
  console.log(`Extracting from: ${binaryPath}`);
  const modules = extractModules(binaryPath);
  console.log(`Found ${modules.length} prompt modules: [${modules.map(m => m.index).join(", ")}]`);

  const combined = Buffer.concat(modules.map(m => m.content));
  const combinedSha256 = crypto.createHash("sha256").update(combined).digest("hex");

  if (targetPath.endsWith(".js")) {
    fs.writeFileSync(targetPath, combined);
    console.log(`Extracted combined bundle to: ${targetPath} (${combined.length} bytes)`);
    console.log(`Combined SHA-256: ${combinedSha256}`);
  } else {
    // Directory mode
    fs.mkdirSync(targetPath, { recursive: true });
    const manifest = {
      version: "2.1.267",
      combinedSha256,
      modules: []
    };

    for (const m of modules) {
      const fileName = `module-${m.index}.js`;
      const filePath = path.join(targetPath, fileName);
      fs.writeFileSync(filePath, m.content);
      manifest.modules.push({
        index: m.index,
        name: m.name,
        file: fileName,
        sha256: m.sha256,
        size: m.content.length
      });
    }

    fs.writeFileSync(path.join(targetPath, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(`Extracted ${modules.length} chunks to directory: ${targetPath}`);
    console.log(`Combined SHA-256: ${combinedSha256}`);
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Repack patched prompt modules into Claude Code native binary
 * Uses in-place replacement to avoid issues with overlapping Bun string pointers
 * Supports directory of patched chunks (with manifest.json) or single-file mode
 * Supports ELF (Linux) and Mach-O (macOS) formats
 */

const LIEF = require("node-lief");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

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
  return { bunOffsets, bunData: Buffer.concat([dataRegion, offsetsBytes, trailerBytes]), dataStart, useRaw: false };
}

function extractFromELFRaw(binaryPath) {
  const buf = fs.readFileSync(binaryPath);
  const trailerIdx = buf.lastIndexOf(BUN_TRAILER);
  if (trailerIdx === -1) throw new Error("Bun trailer not found in binary");
  const offsetsStart = trailerIdx - SIZEOF_OFFSETS;
  const offsetsBytes = buf.subarray(offsetsStart, trailerIdx);
  const bunOffsets = parseOffsets(offsetsBytes);
  const dataStartInFile = offsetsStart - Number(bunOffsets.byteCount);
  const bunData = buf.subarray(dataStartInFile, trailerIdx + BUN_TRAILER.length);
  return { bunOffsets, bunData, dataStartInFile, useRaw: true };
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

/**
 * Patch modules in-place within bunData.
 * modifiedModulesMap: Map of moduleIndex -> Buffer
 */
function patchModulesInPlace(bunData, bunOffsets, modifiedModulesMap) {
  const modulesListBytes = getStringPointerContent(bunData, bunOffsets.modulesPtr);
  const moduleSize = detectModuleSize(modulesListBytes.length);
  const modulesCount = Math.floor(modulesListBytes.length / moduleSize);

  let replacedCount = 0;
  for (const [moduleIndex, modifiedBuf] of modifiedModulesMap.entries()) {
    if (moduleIndex < 0 || moduleIndex >= modulesCount) {
      throw new Error(`Invalid module index: ${moduleIndex}`);
    }
    const module = parseModule(modulesListBytes, moduleIndex * moduleSize);
    const origSize = module.contents.length;
    const newSize = modifiedBuf.length;

    if (newSize > origSize) {
      throw new Error(`Module ${moduleIndex} patched size (${newSize}) exceeds original size (${origSize})`);
    }

    // Overwrite content
    modifiedBuf.copy(bunData, module.contents.offset);

    // Pad remaining with semicolons
    if (newSize < origSize) {
      bunData.fill(0x3B, module.contents.offset + newSize, module.contents.offset + origSize);
    }

    console.log(`  Module ${moduleIndex}: ${origSize} -> ${newSize} bytes (${origSize - newSize} bytes padded with ';')`);
    replacedCount++;
  }

  console.log(`Total modules replaced in-place: ${replacedCount}`);
  return bunData;
}

// Main
const binaryPath = process.argv[2];
const inputPath = process.argv[3]; // Directory or file
const outputPath = process.argv[4];

if (!binaryPath || !inputPath || !outputPath) {
  console.log("Usage: node native-repack.js <binary> <input-dir-or-file> <output>");
  process.exit(1);
}

const modifiedModulesMap = new Map();

if (fs.statSync(inputPath).isDirectory()) {
  const manifestPath = path.join(inputPath, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const mod of manifest.modules) {
      const filePath = path.join(inputPath, mod.file);
      if (fs.existsSync(filePath)) {
        modifiedModulesMap.set(mod.index, fs.readFileSync(filePath));
      }
    }
  } else {
    // Look for module-<index>.js files
    for (const f of fs.readdirSync(inputPath)) {
      const match = f.match(/^module-(\d+)\.js$/);
      if (match) {
        modifiedModulesMap.set(parseInt(match[1]), fs.readFileSync(path.join(inputPath, f)));
      }
    }
  }
} else {
  // Legacy single-file mode: assume module 259 or monolithic
  modifiedModulesMap.set(259, fs.readFileSync(inputPath));
}

LIEF.logging.disable();
const binary = LIEF.parse(binaryPath);
console.log(`Binary format: ${binary.format}`);
console.log(`Repacking ${modifiedModulesMap.size} modules...`);

if (binary.format === "ELF") {
  const binaryBuf = fs.readFileSync(binaryPath);
  const result = extractFromELF(binary, binaryPath);
  const { bunData, bunOffsets, useRaw } = result;

  patchModulesInPlace(bunData, bunOffsets, modifiedModulesMap);

  const dataRegionSize = Number(bunOffsets.byteCount);
  if (useRaw) {
    bunData.copy(binaryBuf, result.dataStartInFile, 0, dataRegionSize);
  } else {
    const elfSize = binaryBuf.length - binary.overlay.length;
    const overlayOffset = elfSize + result.dataStart;
    bunData.copy(binaryBuf, overlayOffset, 0, dataRegionSize);
  }

  const origStat = fs.statSync(binaryPath);
  fs.writeFileSync(outputPath, binaryBuf);
  fs.chmodSync(outputPath, origStat.mode);

} else if (binary.format === "MachO") {
  const bunSegment = binary.getSegment("__BUN");
  const bunSection = bunSegment.getSection("__bun");
  const sectionData = Buffer.from(bunSection.content);

  const bunDataSizeU64 = sectionData.length >= 8 ? Number(sectionData.readBigUInt64LE(0)) : 0;
  const bunDataSizeU32 = sectionData.readUInt32LE(0);
  let headerSize;
  if (sectionData.length >= 8 && 8 + bunDataSizeU64 <= sectionData.length && 8 + bunDataSizeU64 >= sectionData.length - 4096) {
    headerSize = 8;
  } else if (4 + bunDataSizeU32 <= sectionData.length && 4 + bunDataSizeU32 >= sectionData.length - 4096) {
    headerSize = 4;
  } else {
    throw new Error("Cannot determine section header format");
  }

  const result = extractBunDataFromSection(sectionData);
  patchModulesInPlace(result.bunData, result.bunOffsets, modifiedModulesMap);

  result.bunData.copy(sectionData, headerSize);

  if (binary.hasCodeSignature) binary.removeSignature();
  bunSection.content = sectionData;

  const tempPath = outputPath + ".tmp";
  binary.write(tempPath);
  const origStat = fs.statSync(binaryPath);
  fs.chmodSync(tempPath, origStat.mode);
  fs.renameSync(tempPath, outputPath);

  try {
    execSync(`codesign -s - -f "${outputPath}"`, { stdio: "ignore" });
    console.log("Code signed successfully");
  } catch (e) {
    console.warn("Warning: codesign failed, binary may not run");
  }
} else {
  console.error(`Unsupported format: ${binary.format}`);
  process.exit(1);
}

console.log(`Written to: ${outputPath}`);

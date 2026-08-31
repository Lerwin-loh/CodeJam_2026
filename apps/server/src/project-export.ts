import { deflateRawSync } from "node:zlib";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

const excludedDirectories = new Set([".git", ".codex", "node_modules", "dist", "build", "branches"]);
const excludedFiles = new Set(["AGENTS.md", ".env", "README.md"]);

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(): { date: number; time: number } {
  const now = new Date();
  return {
    date: ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2),
  };
}

function generatedReadme(agent: Agent): string {
  return [
    "# " + agent.name,
    "",
    agent.description || "A project exported from Agent Launchpad.",
    "",
    "## Run locally",
    "",
    "1. Install Node.js 22 or newer: https://nodejs.org/",
    "2. Open a terminal in this folder.",
    "3. Install dependencies:",
    "",
    "   ```bash",
    "   npm install",
    "   ```",
    "",
    "4. Start the project using the command documented by its package.json. Common examples:",
    "",
    "   ```bash",
    "   npm run dev",
    "   # or",
    "   npm start",
    "   ```",
    "",
    "If the project is a frontend app, the terminal will print the local URL to open in your browser.",
    "",
    "## Notes",
    "",
    "- This ZIP contains the project source and configuration needed to run it locally.",
    "- Dependencies and generated build folders are intentionally not included; run `npm install` first.",
    "- Platform-managed Agent instructions, workspace history, credentials, and environment files are not included.",
    "- If the project needs secrets or environment variables, create a local `.env` file using the project’s own documentation.",
    "",
  ].join("\n");
}

async function collectFiles(root: string, current = root): Promise<Array<{ name: string; data: Buffer }>> {
  const files: Array<{ name: string; data: Buffer }> = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const relative = path.relative(root, path.join(current, entry.name)).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) files.push(...await collectFiles(root, path.join(current, entry.name)));
    } else if (entry.isFile() && !excludedFiles.has(entry.name)) {
      files.push({ name: relative, data: await readFile(path.join(current, entry.name)) });
    }
  }
  return files;
}

export async function createProjectZip(agent: Agent): Promise<Buffer> {
  const files = await collectFiles(agent.workspacePath);
  files.push({ name: "README.md", data: Buffer.from(generatedReadme(agent), "utf8") });
  files.sort((left, right) => left.name.localeCompare(right.name));

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const { date, time } = dosDateTime();

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const compressed = deflateRawSync(file.data);
    const checksum = crc32(file.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

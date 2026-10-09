import { applyTextPatch } from "../src/integrator.js";
import { snapshotPatch } from "../src/worker.js";
import type { TextFile } from "../src/integrator.js";

const agentCount = Number(process.argv[2] ?? 100);
if (!Number.isInteger(agentCount) || agentCount < 1) throw new Error("Agent count must be a positive integer");

const baseFiles = [{ path: ".agent/context.md", blob: "context", content: "Local stress test context.\n" }];
let mainline: TextFile[] = baseFiles;

for (let agent = 1; agent <= agentCount; agent++) {
  const sourceFiles = [
    ...baseFiles,
    { path: `agents/agent-${agent}.txt`, blob: `agent-${agent}`, content: `agent-${agent}\n` },
  ];
  const result = applyTextPatch(snapshotPatch(baseFiles, sourceFiles), mainline);
  if (result.status !== "applied") throw new Error(`Independent agent ${agent} conflicted: ${JSON.stringify(result.conflicts)}`);
  mainline = result.files;
}

const collisionBase = [{ path: "README.md", blob: "readme", content: "# shared\n" }];
const collisionSourceOne = [{ path: "README.md", blob: "readme-1", content: "# shared: agent 1\n" }];
const collisionSourceTwo = [{ path: "README.md", blob: "readme-2", content: "# shared: agent 2\n" }];
const collisionPatch = snapshotPatch(collisionBase, collisionSourceOne);
const collision = applyTextPatch(collisionPatch, collisionBase);
if (collision.status !== "applied") throw new Error("First collision participant did not apply");
const secondCollision = applyTextPatch(snapshotPatch(collisionBase, collisionSourceTwo), collision.files);
if (secondCollision.status !== "conflict") throw new Error("Second collision participant was not rejected");

const expectedFiles = agentCount + 1;
if (mainline.length !== expectedFiles) throw new Error(`Expected ${expectedFiles} files, got ${mainline.length}`);
console.log(JSON.stringify({
  agents: agentCount,
  independentAdditions: { status: "passed", files: mainline.length },
  sameFileCollision: { status: "passed", reason: secondCollision.conflicts[0]?.reason },
}, null, 2));

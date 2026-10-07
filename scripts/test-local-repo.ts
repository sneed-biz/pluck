import fs from "node:fs/promises";
import path from "node:path";
import git from "isomorphic-git";
import { createTwoFilesPatch } from "diff";
import { applyTextPatch } from "../src/integrator.js";
import { snapshotPatch } from "../src/worker.js";

const dir = path.resolve("iso-test-app");

async function write(relativePath: string, content: string) {
  const filePath = path.join(dir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function commit(message: string, filepaths: string[] = ["src/app.ts"]) {
  for (const filepath of filepaths) {
    await git.add({ fs, dir, filepath });
  }
  return git.commit({
    fs,
    dir,
    message,
    author: { name: "Pluck Fixture", email: "fixture@example.com" },
  });
}

async function readCommitFile(commitSha: string, filePath: string) {
  const { blob } = await git.readBlob({ fs, dir, oid: commitSha, filepath: filePath });
  return new TextDecoder().decode(blob);
}

await fs.rm(dir, { recursive: true, force: true });
await fs.mkdir(dir, { recursive: true });
await git.init({ fs, dir, defaultBranch: "main" });

await write("src/app.ts", "export const greeting = 'hello';\nexport const version = 1;\n");
const base = await commit("chore: seed fixture");

await write("src/app.ts", "export const greeting = 'hello from agent';\nexport const version = 1;\n");
await write("src/new.ts", "export const added = true;\n");
const agentCommit = await commit("feat: customize greeting", ["src/app.ts", "src/new.ts"]);
const agentContent = await readCommitFile(agentCommit, "src/app.ts");
const newFileContent = await readCommitFile(agentCommit, "src/new.ts");
const baseContent = await readCommitFile(base, "src/app.ts");

await git.checkout({ fs, dir, ref: "main" });
await git.writeRef({ fs, dir, ref: "refs/heads/main", value: base, force: true });
await git.checkout({ fs, dir, ref: base, force: true });
await write("README.md", "# iso-test-app\n\nMainline documentation.\n");
const mainlineCommit = await commit("docs: describe fixture", ["README.md"]);
const mainlineContent = await readCommitFile(mainlineCommit, "src/app.ts");
const readmeContent = await readCommitFile(mainlineCommit, "README.md");

const patch = snapshotPatch(
  [{ path: "src/app.ts", blob: "base", content: baseContent }],
  [
    { path: "src/app.ts", blob: "agent", content: agentContent },
    { path: "src/new.ts", blob: "new", content: newFileContent },
  ],
);
const result = applyTextPatch(patch, [
  { path: "README.md", content: readmeContent },
  { path: "src/app.ts", content: mainlineContent },
]);

await git.checkout({ fs, dir, ref: base, force: true });
await write("src/app.ts", "export const greeting = 'hello from another agent';\nexport const version = 1;\n");
const conflictingMainline = await commit("feat: alternate greeting");
const conflictingContent = await readCommitFile(conflictingMainline, "src/app.ts");
const conflictResult = applyTextPatch(patch, [{ path: "src/app.ts", content: conflictingContent }]);

if (result.status !== "applied") throw new Error("Clean integration failed before collision resolution");
const integratedContent = result.files.find((file) => file.path === "src/app.ts")?.content;
if (!integratedContent) throw new Error("Integrated file was not produced");

// Resolution is explicit: a human or coordinator chooses the final content.
// Pluck never silently guesses how two agent intents should be combined.
const resolvedContent = "export const greeting = 'hello from both agents';\nexport const version = 1;\n";
const resolutionPatch = createTwoFilesPatch(
  "a/src/app.ts",
  "b/src/app.ts",
  integratedContent,
  resolvedContent,
);
const resolutionResult = applyTextPatch(resolutionPatch, [{ path: "src/app.ts", content: integratedContent }]);

console.log(JSON.stringify({
  fixture: dir,
  base,
  agentCommit,
  mainlineCommit,
  conflictingMainline,
  patch,
  result,
  conflictResult,
  resolutionPatch,
  resolutionResult,
}, null, 2));

if (
  result.status !== "applied" ||
  !result.files.find((file) => file.path === "src/app.ts")?.content.includes("hello from agent") ||
  !result.files.find((file) => file.path === "src/new.ts")?.content.includes("added = true")
) {
  throw new Error("Local Pluck integration fixture failed");
}
if (conflictResult.status !== "conflict") throw new Error("Conflict fixture failed");
if (resolutionResult.status !== "applied" || resolutionResult.files[0]?.content !== resolvedContent) {
  throw new Error("Explicit conflict resolution fixture failed");
}

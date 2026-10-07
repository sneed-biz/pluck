import * as git from "isomorphic-git";

const exports = Object.keys(git).sort();
const patchCandidates = exports.filter((name) => /patch|apply|diff/i.test(name));

console.log(JSON.stringify({
  package: "isomorphic-git",
  patchCandidates,
  hasApplyPatch: "applyPatch" in git,
  hasDiff: "diff" in git,
  recommendation: "If hasApplyPatch is false, implement or adopt a tested unified-diff adapter before building the queue.",
}, null, 2));

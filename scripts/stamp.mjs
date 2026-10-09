// Grava dist/build.json com a hora do build e o commit, pra o /health mostrar QUAL versao esta no ar.
import { execSync } from "node:child_process";
import fs from "node:fs";

let commit = process.env.SOURCE_COMMIT || process.env.COMMIT_SHA || process.env.GIT_SHA || "";
if (!commit) {
  try {
    commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    commit = "desconhecido";
  }
}
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/build.json", JSON.stringify({ commit: commit.slice(0, 12), builtAt: new Date().toISOString() }));
console.log("build:", commit.slice(0, 12));

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const frontendDist = path.join(repoRoot, "frontend", "dist");
const serverPublic = path.join(repoRoot, "server", "public");

function assertFrontendBuilt() {
  const required = ["index.js", "index.css", "_index.html"];
  const missing = required.filter((file) => !fs.existsSync(path.join(frontendDist, file)));
  if (missing.length === 0) return;
  throw new Error(
    `Frontend build is missing ${missing.join(", ")}. Run "cd frontend && yarn build" before packaging.`
  );
}

function copyDir(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

assertFrontendBuilt();
copyDir(frontendDist, serverPublic);
console.log(`Desktop frontend assets copied to ${serverPublic}`);

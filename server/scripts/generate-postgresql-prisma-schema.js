#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const serverRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(serverRoot, "prisma", "schema.prisma");
const targetDirectory = path.join(serverRoot, "prisma", "postgresql");
const targetPath = path.join(targetDirectory, "schema.prisma");

function postgresqlSchema(source) {
  const generators = `generator mainClient {
  provider = "prisma-client-js"
  output   = "../../generated/postgresql-main"
}

generator authClient {
  provider = "prisma-client-js"
  output   = "../../generated/postgresql-auth"
}`;
  return source
    .replace(/generator client\s*\{[\s\S]*?\}/, generators)
    .replace(/\/\/ Uncomment the following lines[\s\S]*?\/\/ \}\r?\n/, "")
    .replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"');
}

function main() {
  const source = fs.readFileSync(sourcePath, "utf8");
  const generated = postgresqlSchema(source);
  fs.mkdirSync(targetDirectory, { recursive: true });
  fs.writeFileSync(targetPath, generated, "utf8");
  console.log(
    JSON.stringify({
      success: true,
      source: path.relative(serverRoot, sourcePath),
      target: path.relative(serverRoot, targetPath),
      bytes: Buffer.byteLength(generated, "utf8"),
    })
  );
}

if (require.main === module) main();

module.exports = { postgresqlSchema };

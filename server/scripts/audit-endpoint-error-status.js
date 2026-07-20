#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const espree = require("espree");
const estraverse = require("estraverse");

const endpointRoot = path.resolve(__dirname, "../endpoints");

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(target);
    return entry.isFile() && entry.name.endsWith(".js") ? [target] : [];
  });
}

function findingsFor(file) {
  const source = fs.readFileSync(file, "utf8");
  const ast = espree.parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    range: true,
    loc: true,
  });
  const catches = [];
  estraverse.traverse(ast, {
    enter(node) {
      if (node.type !== "CatchClause" || node.param?.type !== "Identifier")
        return;
      const errorName = node.param.name;
      estraverse.traverse(node.body, {
        enter(candidate) {
          if (candidate.type === "CatchClause" && candidate !== node)
            return this.skip();
          if (candidate.type !== "CallExpression") return;
          const callee = candidate.callee;
          if (
            callee?.type !== "MemberExpression" ||
            !["status", "sendStatus"].includes(callee.property?.name) ||
            candidate.arguments?.[0]?.type !== "Literal" ||
            candidate.arguments[0].value !== 500
          )
            return;
          catches.push({
            file,
            line: candidate.loc.start.line,
            range: candidate.arguments[0].range,
            replacement: `${errorName}.httpStatus || 500`,
          });
        },
      });
      return this.skip();
    },
  });
  return { source, findings: catches };
}

function main() {
  const execute = process.argv.includes("--execute");
  const reports = walk(endpointRoot)
    .map((file) => ({ file, ...findingsFor(file) }))
    .filter((report) => report.findings.length > 0);
  for (const report of reports) {
    if (!execute) continue;
    let output = report.source;
    for (const finding of [...report.findings].sort(
      (left, right) => right.range[0] - left.range[0]
    )) {
      output = `${output.slice(0, finding.range[0])}${finding.replacement}${output.slice(finding.range[1])}`;
    }
    fs.writeFileSync(report.file, output);
  }
  const count = reports.reduce(
    (sum, report) => sum + report.findings.length,
    0
  );
  console.log(
    JSON.stringify({
      mode: execute ? "execute" : "audit",
      findings: count,
      files: reports.map((report) => ({
        file: path.relative(path.resolve(__dirname, ".."), report.file),
        count: report.findings.length,
      })),
    })
  );
  if (!execute && count > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { findingsFor };

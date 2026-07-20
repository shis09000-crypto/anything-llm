#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const espree = require("espree");
const estraverse = require("estraverse");

const modelsRoot = path.resolve(__dirname, "../models");
const helperImport =
  'const { throwModelDataAccessError } = require("../utils/dataAccess/modelErrors");\n';

function isDefaultReturn(node) {
  if (node?.type !== "ReturnStatement") return false;
  const value = node.argument;
  if (!value) return true;
  if (value.type === "ArrayExpression" && value.elements.length === 0)
    return true;
  return (
    value.type === "Literal" &&
    (value.value === null || value.value === false || value.value === 0)
  );
}

function isConsoleStatement(node) {
  const expression =
    node?.type === "ExpressionStatement" ? node.expression : null;
  const callee =
    expression?.type === "CallExpression" ? expression.callee : null;
  return (
    callee?.type === "MemberExpression" &&
    callee.object?.type === "Identifier" &&
    callee.object.name === "console" &&
    ["error", "warn"].includes(callee.property?.name)
  );
}

function operationName(ancestors, file) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const node = ancestors[index];
    if (node.type === "Property") {
      const key = node.key?.name || node.key?.value;
      if (key) return `${path.basename(file, ".js")}.${key}`;
    }
    if (node.type === "FunctionDeclaration" && node.id?.name)
      return `${path.basename(file, ".js")}.${node.id.name}`;
  }
  return `${path.basename(file, ".js")}.databaseOperation`;
}

function findingsFor(file) {
  const source = fs.readFileSync(file, "utf8");
  const ast = espree.parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    range: true,
    loc: true,
  });
  const ancestors = [];
  const findings = [];
  estraverse.traverse(ast, {
    enter(node) {
      if (node.type === "CatchClause" && node.param?.name === "error") {
        const statements = node.body.body;
        const returns = statements.filter(isDefaultReturn);
        const allowedStatements = statements.every(
          (statement) =>
            isDefaultReturn(statement) || isConsoleStatement(statement)
        );
        const tryNode = ancestors.at(-1);
        const trySource =
          tryNode?.type === "TryStatement"
            ? source.slice(tryNode.block.range[0], tryNode.block.range[1])
            : "";
        if (
          returns.length === 1 &&
          allowedStatements &&
          /\b(?:prisma|authPrisma)\./.test(trySource)
        ) {
          findings.push({
            file,
            line: node.loc.start.line,
            range: node.body.range,
            operation: operationName(ancestors, file),
          });
        }
      }
      ancestors.push(node);
    },
    leave() {
      ancestors.pop();
    },
  });
  return { source, findings };
}

function rewrite(file, source, findings) {
  let output = source;
  for (const finding of [...findings].sort(
    (left, right) => right.range[0] - left.range[0]
  )) {
    output = `${output.slice(0, finding.range[0])}{\n      throwModelDataAccessError(${JSON.stringify(
      finding.operation
    )}, error);\n    }${output.slice(finding.range[1])}`;
  }
  if (findings.length > 0 && !source.includes("throwModelDataAccessError"))
    output = `${helperImport}${output}`;
  fs.writeFileSync(file, output);
}

function main() {
  const execute = process.argv.includes("--execute");
  const files = fs
    .readdirSync(modelsRoot)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(modelsRoot, name));
  const reports = files
    .map((file) => ({ file, ...findingsFor(file) }))
    .filter((report) => report.findings.length > 0);
  const findings = reports.flatMap((report) => report.findings);

  if (execute) {
    for (const report of reports)
      rewrite(report.file, report.source, report.findings);
  }
  console.log(
    JSON.stringify(
      {
        mode: execute ? "execute" : "audit",
        findings: findings.length,
        files: reports.map((report) => ({
          file: path.relative(path.resolve(__dirname, ".."), report.file),
          count: report.findings.length,
          lines: report.findings.map((finding) => finding.line),
        })),
      },
      null,
      2
    )
  );
  if (!execute && findings.length > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { findingsFor, isDefaultReturn, operationName };

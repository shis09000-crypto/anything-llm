#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { ROOT, writeReport } = require("../../scripts/athena-3d-test-lib.cjs");

const REPORT_DIR = path.join(ROOT, "reports/athena-3d-center");
const OWN_OUTPUTS = new Set(["summary.json", "summary.zh-CN.md"]);

function resultLabel(status) {
  return (
    {
      passed: "通过",
      failed: "失败",
      infrastructure_failed: "基础设施失败",
    }[status] || "未知"
  );
}

function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reports = fs
    .readdirSync(REPORT_DIR)
    .filter((name) => name.endsWith(".json") && !OWN_OUTPUTS.has(name))
    .map((name) => {
      const location = path.join(REPORT_DIR, name);
      try {
        const payload = JSON.parse(fs.readFileSync(location, "utf8"));
        return {
          file: name,
          suite: payload.suite || name.replace(/\.json$/, ""),
          status: payload.status || "unknown",
          generated_at: payload.generated_at || null,
          error: payload.error || null,
        };
      } catch (error) {
        return {
          file: name,
          suite: name.replace(/\.json$/, ""),
          status: "failed",
          generated_at: null,
          error: { code: "REPORT_PARSE_FAILED", message: error.message },
        };
      }
    })
    .sort((left, right) => left.suite.localeCompare(right.suite));
  const counts = reports.reduce((summary, report) => {
    summary[report.status] = (summary[report.status] || 0) + 1;
    return summary;
  }, {});
  const status = reports.some((report) => report.status !== "passed")
    ? "failed"
    : "passed";
  const { report } = writeReport("summary", {
    suite: "athena_3d_center_summary",
    status,
    counts,
    reports,
  });
  const lines = [
    "# Athena 3D Center 全面测试报告",
    "",
    `生成时间：${new Date(report.generated_at).toISOString()}`,
    "",
    `总体状态：${resultLabel(status)}`,
    "",
    "| 套件 | 状态 | 报告 | 失败原因 |",
    "|---|---|---|---|",
    ...reports.map(
      (item) =>
        `| ${item.suite} | ${resultLabel(item.status)} | ${item.file} | ${item.error?.code || "-"} |`
    ),
    "",
    "说明：Nightly、Release的关键环境缺失会记为基础设施失败，不会被标记为跳过。",
    "",
  ];
  fs.writeFileSync(
    path.join(REPORT_DIR, "summary.zh-CN.md"),
    lines.join("\n"),
    "utf8"
  );
  console.log(JSON.stringify(report, null, 2));
}

main();

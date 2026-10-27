// 安装脚本调用入口：应用 Phase-1 系统提示词过滤补丁。
//
// 与 apply-patch.mjs 同样用意：避免 MSYS 的 /c/... 路径被拼进 JS 字符串。

import { applyPhase1Patch } from "./lib/patcher.js";

const [, , dshHome] = process.argv;

if (!dshHome) {
  console.error("Usage: node scripts/apply-phase1.mjs <dshHome>");
  process.exit(2);
}

const result = applyPhase1Patch(dshHome);

if (result.status === "missing_files") {
  // 找不到宿主包是正常情况（不同安装布局），不算失败。
  console.log("[fujiang-armor] phase-1: 未找到宿主 bootstrap 文件，跳过");
  process.exit(0);
}

const summary = (result.results ?? [])
  .map((r) => `${r.status}${r.file ? ` (${r.file})` : ""}${r.error ? `: ${r.error}` : ""}`)
  .join("; ");
console.log(`[fujiang-armor] phase-1: ${result.status}${summary ? " — " + summary : ""}`);

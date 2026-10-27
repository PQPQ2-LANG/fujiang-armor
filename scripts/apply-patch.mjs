// 安装脚本调用入口：收敛一个 profile 的 cordis.patch.yml 挂载。
//
// 用独立文件而不是 node -e "import('/c/...')"：在 Git Bash / MSYS 下
// $SRC_DIR 是 /c/Users/... 形式，写进 JS 字符串后 Node 无法解析——之前
// install.sh 里那行 applyAllPatches 调用因此长期静默失败（还被
// 2>/dev/null 和 .catch(()=>{}) 双重吞掉），配置其实从未被真正收敛过。
// 作为命令行参数传入时 MSYS 会自动转换成 Windows 路径。

import { applyCordisPatch } from "./lib/patcher.js";

const [, , profileDir, pluginName = "fujiang-armor"] = process.argv;

if (!profileDir) {
  console.error("Usage: node scripts/apply-patch.mjs <profileDir> [pluginName]");
  process.exit(2);
}

const result = applyCordisPatch(profileDir, pluginName);

if (result.status === "error") {
  console.error(`[fujiang-armor] ${result.path}: ${result.error}`);
  process.exit(1);
}

console.log(
  `[fujiang-armor] ${profileDir}: ${result.status} (mount=${result.mount ?? "unknown"})`,
);

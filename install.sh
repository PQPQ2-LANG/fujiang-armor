#!/usr/bin/env bash
# 破甲安装脚本
set -euo pipefail

PLUGIN_NAME="fujiang-armor"
PLUGIN_LABEL="破甲"
LEGACY_PLUGINS=()
DSH_ROOT="${DSH_HOME:-$HOME/.dsh}"
PLUGINS_DIR="$DSH_ROOT/plugins"
DEST_DIR="$PLUGINS_DIR/$PLUGIN_NAME"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step() { printf "\n==> %s\n" "$1"; }
ok()   { printf "    [OK] %s\n" "$1"; }
warn() { printf "    [!] %s\n" "$1"; }
err()  { printf "    [X] %s\n" "$1" >&2; }

# ---------- 探测 DSH profile 目录（web / default / 手动选择） ----------
find_profile_dirs() {
  local profiles_root="$1"

  if [[ -n "${DSH_PROFILE:-}" ]]; then
    local cand="$profiles_root/$DSH_PROFILE"
    if [[ -f "$cand/package.json" ]]; then echo "$cand"; return 0; fi
    warn "环境变量 DSH_PROFILE 指向的目录不存在：$cand（继续自动探测）"
  fi

  local found=()
  for name in web default desktop; do
    local cand="$profiles_root/$name"
    if [[ -f "$cand/package.json" ]]; then found+=("$cand"); fi
  done
  if [[ ${#found[@]} -gt 0 ]]; then printf '%s\n' "${found[@]}"; return 0; fi

  local dirs=()
  for d in "$profiles_root"/*/; do
    [[ -d "$d" && -f "$d/package.json" ]] && dirs+=("$d")
  done
  if [[ ${#dirs[@]} -eq 1 ]]; then echo "${dirs[0]}"; return 0; fi
  if [[ ${#dirs[@]} -gt 1 ]]; then
    echo "检测到多个 DSH profile，请选择要安装的目标：" >&2
    for i in "${!dirs[@]}"; do printf "  [%d] %s\n" "$((i+1))" "${dirs[$i]}" >&2; done
    read -rp "请输入序号: " sel
    local idx=$((sel-1))
    if (( idx >= 0 && idx < ${#dirs[@]} )); then echo "${dirs[$idx]}"; return 0; fi
    err "选择无效，退出。"
    exit 1
  fi
  return 1
}

# ---------- [1] 检查环境 ----------
step "检查环境"

[[ -d "$DSH_ROOT" ]] || { err "未找到 DSH 目录：$DSH_ROOT"; exit 1; }
mapfile -t PROFILE_DIRS < <(find_profile_dirs "$DSH_ROOT/profiles") || {
  err "未找到 DSH profile 目录（$DSH_ROOT/profiles 下没有含 package.json 的目录）。"
  echo "可通过环境变量指定：DSH_PROFILE=web（或 default）后重新运行。"
  exit 1
}
for p in "${PROFILE_DIRS[@]}"; do ok "DSH profile 目录：$p"; done

command -v pnpm >/dev/null 2>&1 || {
  err "未检测到 pnpm，请先安装：npm install -g pnpm"
  exit 1
}
ok "pnpm 可用：$(command -v pnpm)"

# Node 解释器：后续所有 node 调用都走这个变量，避免 PATH 差异导致静默失败。
command -v node >/dev/null 2>&1 || {
  err "未检测到 node，请先安装 Node.js 22 或更新版本"
  exit 1
}
NODE_BIN="$(command -v node)"
ok "node 可用：$NODE_BIN ($("$NODE_BIN" --version 2>/dev/null))"

# ---------- [1.5] 清理旧版残留 ----------
step "检查旧版本"

"$NODE_BIN" "$SRC_DIR/scripts/lib/migrate.js" "$DSH_ROOT" "${PROFILE_DIRS[@]}" >/dev/null
ok "旧版注册与依赖已迁移，配置备份已保留。"

for old in "${LEGACY_PLUGINS[@]}"; do
  if [[ -d "$PLUGINS_DIR/$old" ]]; then
    rm -rf "$PLUGINS_DIR/$old"
    ok "已清理旧版插件目录：$PLUGINS_DIR/$old"
  fi
done

# ---------- [2] 复制插件（自动覆盖旧版） ----------
step "复制插件文件"

mkdir -p "$PLUGINS_DIR"
if [[ -d "$DEST_DIR" ]]; then
  warn "检测到已存在的 $PLUGIN_NAME 目录，自动覆盖更新"
  rm -rf "$DEST_DIR"
fi
mkdir -p "$DEST_DIR"
cp -R "$SRC_DIR"/. "$DEST_DIR"/
rm -rf "$DEST_DIR/.git" "$DEST_DIR/install.sh" "$DEST_DIR/uninstall.sh" \
       "$DEST_DIR/install.ps1" "$DEST_DIR/uninstall.ps1" 2>/dev/null || true
ok "插件已复制到：$DEST_DIR"

# ---------- [3] 备份 package.json ----------
step "备份 package.json"

for p in "${PROFILE_DIRS[@]}"; do
  BAK_PATH="$p/package.json.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$p/package.json" "$BAK_PATH"
  ok "备份完成：$BAK_PATH"
done

# ---------- [4] 写入依赖与 bundles（幂等 + 迁移旧版） ----------
step "写入 profile 配置"

for p in "${PROFILE_DIRS[@]}"; do
  PKG_PATH="$p/package.json"
  PATCH_PATH="$p/cordis.patch.yml"
  "$NODE_BIN" - "$PKG_PATH" "$PATCH_PATH" "$PLUGIN_NAME" "${LEGACY_PLUGINS[@]}" <<'NODE'
const fs = require("fs");
const [pkgPath, patchPath, name, ...legacy] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.dependencies = pkg.dependencies || {};
for (const old of legacy) delete pkg.dependencies[old];
pkg.dependencies[name] = "file:../../plugins/" + name;
// 只清理旧版条目。不要把 name 从 bundles 里剔除：市场（dshmarket）安装插件时
// 会把它加进 bundles，两边来回改会让「bundle 自带 patch」与「user-patch insert」
// 同时存在，同一 id 出现两行 → "duplicate loader entry id" 安装回滚。
if (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) {
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => !legacy.includes(b));
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// cordis.patch.yml 的挂载收敛在 pnpm install 之后进行（那时 node_modules 里
// 才有这个包，才能判断 bundle 是否自带挂载）。此处只清掉模板遗留的 `[]`
// 占位符和旧版残留，避免文件整体解析失败。
let text = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, "utf8") : "";
const before = text;
text = text.replace(/^[ \t]*\[\][ \t]*$/gm, "");
for (const old of legacy) {
  const reg = new RegExp("^\\s*-\\s*insert:\\s*\\r?\\n\\s*-\\s*id:\\s*" + old + "[\\s\\S]*?(?=(^\\s*-\\s*insert:|\\z))", "gm");
  text = text.replace(reg, "");
}
if (text !== before) {
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  fs.writeFileSync(patchPath, (text ? text + "\n" : ""));
}
NODE
  ok "package.json 已更新，cordis.patch.yml 占位符已清理：$p"

  # ---------- [4.5] 自动应用 0.1.6 核心兼容补丁 ----------
  # 用独立入口传参：node -e "import('$SRC_DIR/...')" 在 MSYS 下会把 /c/... 拼进
  # JS 字符串，Node 解析不到 → 长期静默失败。这里保留错误输出便于排查。
  if ! "$NODE_BIN" "$SRC_DIR/scripts/apply-phase1.mjs" "$DSH_ROOT"; then
    warn "Phase-1 提示词过滤补丁未应用（不影响插件加载）"
  fi
  ok "0.1.6 核心指令过滤补丁已就绪"

  # ---------- [5] pnpm install ----------
  step "安装依赖（pnpm install）"

  # pnpm 对 file: 依赖是复制进 node_modules 而非实时链接；先清除旧拷贝，
  # 强制 pnpm 重新同步，避免更新插件后 index.js/client.js 不同步
  if [[ -d "$p/node_modules/$PLUGIN_NAME" ]]; then
    rm -rf "$p/node_modules/$PLUGIN_NAME"
    ok "已清除 node_modules 旧拷贝，pnpm 将重新同步"
  fi
  for old in "${LEGACY_PLUGINS[@]}"; do
    if [[ -d "$p/node_modules/$old" ]]; then rm -rf "$p/node_modules/$old"; fi
  done

  # 优先建立软链接
  mkdir -p "$p/node_modules"
  ln -sfn "$DEST_DIR" "$p/node_modules/$PLUGIN_NAME" 2>/dev/null || true

  (
    cd "$p"
    if ! pnpm install; then
      err "pnpm install 失败，请手动执行：cd $p && pnpm install"
      exit 1
    fi
  )
  ok "依赖安装完成"

  # ---------- [5.5] 收敛 cordis.patch.yml 的挂载（必须在 pnpm install 之后） ----------
  # 此刻 node_modules 里才有这个包，才能判断「bundle 自带 patch 是否已插入本 id」。
  # 已由 bundle 挂载时删掉 user-patch 的重复行；未挂载时补唯一一行。
  # 复用 patcher.js 里的同一份实现，避免脚本与运行期逻辑各写一套而互相打架。
  # 用独立入口传参，避免 MSYS 把 /c/... 形式拼进 JS 字符串后 Node 解析失败。
  if "$NODE_BIN" "$SRC_DIR/scripts/apply-patch.mjs" "$p" "$PLUGIN_NAME"; then
    ok "cordis.patch.yml 挂载已收敛：$p"
  else
    warn "cordis.patch.yml 收敛失败，请检查 $p/cordis.patch.yml"
  fi
done

# ---------- [6] 完成 ----------
step "安装完成"

cat <<EOF

  $PLUGIN_LABEL v0.4.3 已安装！
  目标 profile：$(printf '%s ' "${PROFILE_DIRS[@]}" | sed 's/ *$//')
  最后一步：重启 DeepSeek Harness（Web 版刷新页面 / 桌面版重新打开），新建会话即可生效。
  验证方法：重启后输入框上方应显示绿色状态条「破甲已激活」。
  卸载方法：运行 ./uninstall.sh。
EOF

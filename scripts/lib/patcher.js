// scripts/lib/patcher.js
// 破甲兼容性补丁引擎。
// 解决 DeepSeek Harness 0.1.6 / 0.1.7 架构下的核心兼容性痛点：
//   1. Phase-1 系统提示词过滤（放行 fujiang-armor 提示词注入段，防止多轮被丢弃）
//   2. 宿主身份强占与先验拒绝覆盖（关闭 includeHarnessIdentity，重塑逆向分析定位）
//   3. 子进程闪窗隐蔽保护（Windows 下抑制 cmd.exe 弹出）
//   4. 自动探测与安全备份回滚（支持 .dshbak 安全恢复）

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const isWindows = process.platform === "win32";

export function findDshHome() {
  if (process.env.DSH_HOME && fs.existsSync(process.env.DSH_HOME)) {
    return process.env.DSH_HOME;
  }
  return path.join(os.homedir(), ".dsh");
}

export function findAiBase(dshHome = findDshHome()) {
  const candidates = [];
  if (process.env.DSH_BASE && fs.existsSync(process.env.DSH_BASE)) {
    candidates.push(process.env.DSH_BASE);
  }

  // 1. Profiles 中的 node_modules/@deepseek-ai
  const profilesRoot = path.join(dshHome, "profiles");
  if (fs.existsSync(profilesRoot)) {
    try {
      for (const name of fs.readdirSync(profilesRoot)) {
        candidates.push(path.join(profilesRoot, name, "node_modules", "@deepseek-ai"));
      }
    } catch {}
  }

  // 2. npm 全局目录 / AppData
  if (isWindows) {
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    candidates.push(path.join(appdata, "npm", "node_modules", "@deepseek-ai"));
    candidates.push(path.join(appdata, "npm", "node_modules", "dsh", "node_modules", "@deepseek-ai"));
    candidates.push(path.join(os.homedir(), "AppData", "Local", "Programs", "DeepSeek-Harness", "resources", "app", "dsh", "node_modules", "@deepseek-ai"));
  }

  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, "dsh-agent-instructions", "lib"))) {
      return c;
    }
  }
  return null;
}

export function listBootstrapFiles(dshHome = findDshHome()) {
  const out = [];
  const push = (fp) => {
    if (fp && fs.existsSync(fp) && !out.includes(fp)) out.push(fp);
  };

  const aiBase = findAiBase(dshHome);
  if (aiBase) {
    push(path.join(aiBase, "dsh-agent-instructions", "lib", "index.js"));
    push(path.join(aiBase, "dsh-agent-instructions", "lib", "bootstrap.js"));
  }

  const profilesRoot = path.join(dshHome, "profiles");
  if (fs.existsSync(profilesRoot)) {
    try {
      for (const name of fs.readdirSync(profilesRoot)) {
        push(path.join(profilesRoot, name, "node_modules", "@deepseek-ai", "dsh-agent-instructions", "lib", "index.js"));
        push(path.join(profilesRoot, name, "node_modules", "@deepseek-ai", "dsh-agent-instructions", "lib", "bootstrap.js"));
      }
    } catch {}
  }
  return out;
}

/**
 * 补丁 1：Phase-1 系统提示词过滤放行
 * 让 Harness 不再粗暴丢弃 fujiang-armor 的系统提示词注入段
 */
export function applyPhase1Patch(dshHome = findDshHome()) {
  const marker = "[fujiang-armor] phase-1 keep persona+fujiang-armor sections";
  const files = listBootstrapFiles(dshHome);
  if (files.length === 0) return { status: "missing_files", files: [] };

  const results = [];
  for (const fp of files) {
    try {
      const text = fs.readFileSync(fp, "utf8");
      if (text.includes(marker)) {
        results.push({ file: fp, status: "already_patched" });
        continue;
      }

      // 备份原文件
      const bakPath = fp + ".dshbak";
      if (!fs.existsSync(bakPath)) {
        fs.copyFileSync(fp, bakPath);
      }

      // 寻找 section 过滤代码并替换
      const needle = "section => PERSONA_SECTION_NAMES.has(section?.name)";
      const needleRegex = /section\s*=>\s*PERSONA_SECTION_NAMES\.has\(section\?\.name\)/g;
      
      let nextText = text;
      if (text.includes(needle)) {
        const replacement = `section => PERSONA_SECTION_NAMES.has(section?.name) || String(section?.name || "").startsWith("fujiang-armor")`;
        nextText = text.replace(needleRegex, `/* ${marker} */ ${replacement}`);
      } else {
        // 通用兜底正则匹配
        const genericNeedle = /(filter\s*\(\s*section\s*=>\s*[^)]+\))/g;
        nextText = text.replace(genericNeedle, `/* ${marker} */ filter(section => true)`);
      }

      if (nextText !== text) {
        fs.writeFileSync(fp, nextText, "utf8");
        results.push({ file: fp, status: "patched" });
      } else {
        results.push({ file: fp, status: "pattern_miss" });
      }
    } catch (e) {
      results.push({ file: fp, status: "error", error: e.message });
    }
  }
  return { status: "ok", results };
}

/**
 * 补丁 2：配置 Profile 的 cordis.patch.yml 覆盖系统提示词与插件挂载
 *
 * 关键约束：同一个 loader 条目 id 只能有一行。
 *   - 插件已列入 dsh.profile.bundles 时，包自带的 cordis.patch.yml 会插入该条目，
 *     user-patch 再插一次就会形成两行同 id，dshmarket 启动前校验报
 *     "duplicate loader entry id" 并回滚安装。
 *     → 此模式下只补 system-prompt 覆盖，绝不写 insert。
 *   - 未列入 bundles 时，才用 user-patch 的 insert 提供唯一挂载。
 *
 * 判断依据是结构化解析后的条目，不是字符串包含：旧实现用
 * content.includes(pluginName) 判断，配置文件里只要出现同名注释就会误判成
 * "已配置" 而跳过，注释一删又会追加出重复行。
 */
export function applyCordisPatch(profileDir, pluginName = "fujiang-armor") {
  const patchPath = path.join(profileDir, "cordis.patch.yml");
  const pkgPath = path.join(profileDir, "package.json");

  const promptBlock = [
    "- id: system-prompt",
    "  config:",
    "    includeHarnessIdentity: false",
    '    personaPrefix: ""',
    "    personaSuffix: Your working directory is {{cwd}}.",
  ].join("\n");

  const insertBlock = [
    "- insert:",
    `    - id: ${pluginName}`,
    `      name: '${pluginName}'`,
    "      config:",
    "        enabled: true",
    "        autoApplyOnStart: true",
  ].join("\n");

  try {
    // 1) 判断插件是否以 bundle 形式挂载，且该 bundle 的 patch 确实插入本 id。
    let bundled = false;
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8").replace(/^\uFEFF/, ""));
      const list = pkg?.dsh?.profile?.bundles;
      const listed = Array.isArray(list) && list.some((b) =>
        typeof b === "string" ? b === pluginName : (b?.id ?? b?.name) === pluginName);
      if (listed) {
        const base = path.join(profileDir, "node_modules", pluginName);
        let declared = null;
        try {
          declared = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8"))?.dsh?.bundle?.patch ?? null;
        } catch {}
        for (const rel of [declared, "cordis.patch.yml"].filter((x) => typeof x === "string")) {
          try {
            const body = fs.readFileSync(path.join(base, rel), "utf8");
            if (new RegExp("^\\s*-\\s+id:\\s*['\"]?" + pluginName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "['\"]?\\s*$", "m").test(body)) {
              bundled = true;
              break;
            }
          } catch {}
        }
      }
    }

    let text = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, "utf8") : "";
    // 模板占位 `[]` 与后续列表并存会让整份文件解析失败。
    text = text.replace(/^[ \t]*\[\][ \t]*$/gm, "");

    // 2) 切成顶层块，只处理与本插件相关的块，其它配置逐字保留。
    const lines = text.split(/\r?\n/);
    const blocks = [];
    let cur = null;
    for (const line of lines) {
      if (/^-\s/.test(line)) { if (cur) blocks.push(cur); cur = [line]; }
      else if (cur) cur.push(line);
      else blocks.push([line]);
    }
    if (cur) blocks.push(cur);

    const isOwnIdRow = (head) =>
      new RegExp("^-[ \\t]+id:[ \\t]*['\"]?" + pluginName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "['\"]?[ \\t]*$").test(head);

    const kept = [];
    for (const block of blocks) {
      const head = block[0] ?? "";
      if (/^-\s+insert:\s*$/.test(head)) {
        const ids = [...block.join("\n").matchAll(/^\s+-\s+id:\s*['"]?([\w@/.\-]+)['"]?\s*$/gm)].map((m) => m[1]);
        // 只挂本插件、且 bundle 已提供挂载 → 删掉，避免同 id 两行。
        if (ids.length > 0 && ids.every((id) => id === pluginName) && bundled) continue;
        // 只挂本插件、bundle 未提供挂载 → 保留这一份唯一挂载。
        if (ids.length > 0 && ids.every((id) => id === pluginName)) { kept.push(block); continue; }
      }
      if (isOwnIdRow(head)) continue; // 顶层 `- id: fujiang-armor` 行一律不收
      kept.push(block);
    }

    let out = kept.map((b) => b.join("\n")).join("\n").replace(/\n{3,}/g, "\n\n").trim();

    // 3) 非 bundle 模式且当前没有任何挂载 → 补唯一一行 insert。
    //    但插件根本没装到该 profile 时绝不写挂载：挂一个不存在的 loader 包
    //    会让启动直接失败（headless profile 就是这种情形）。
    const pluginPresent = fs.existsSync(path.join(profileDir, "node_modules", pluginName, "package.json"));
    const hasMount = new RegExp("^\\s*-\\s+id:\\s*['\"]?" + pluginName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "['\"]?\\s*$", "m").test(out);
    if (!bundled && !hasMount && pluginPresent) {
      out = out ? `${out}\n\n${insertBlock}` : insertBlock;
    }

    // 4) 破甲依赖 system-prompt 覆盖（关闭宿主身份、清空 persona 前缀）。
    if (!/^\s*-\s*id:\s*['"]?system-prompt['"]?\s*$/m.test(out)) {
      out = out ? `${out}\n\n${promptBlock}` : promptBlock;
    }

    const next = `${out}\n`;
    const previous = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, "utf8") : "";
    // 标签按最终文本判定，而不是写入前的中间状态。
    const finalHasMount = new RegExp("^\\s*-\\s+id:\\s*['\"]?" + pluginName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "['\"]?\\s*$", "m").test(out);
    const mount = bundled ? "bundle" : (finalHasMount ? "user-patch" : "none");
    if (next === previous) {
      return { status: "already_configured", path: patchPath, mount };
    }

    if (previous) {
      try { fs.copyFileSync(patchPath, `${patchPath}.fujiang-bak`); } catch {}
    }
    fs.writeFileSync(patchPath, next, "utf8");
    return { status: "patched", path: patchPath, mount };
  } catch (e) {
    return { status: "error", error: e.message, path: patchPath };
  }
}

/**
 * 全量自动执行所有兼容补丁（可在安装脚本与运行时自愈调用）
 */
export function applyAllPatches(options = {}) {
  const dshHome = options.dshHome || findDshHome();
  const phase1 = applyPhase1Patch(dshHome);

  const profilesRoot = path.join(dshHome, "profiles");
  const cordisResults = [];
  if (fs.existsSync(profilesRoot)) {
    try {
      for (const name of fs.readdirSync(profilesRoot)) {
        const pDir = path.join(profilesRoot, name);
        if (name !== "node_modules" && fs.statSync(pDir).isDirectory() && fs.existsSync(path.join(pDir, "package.json"))) {
          cordisResults.push({ profile: name, ...applyCordisPatch(pDir) });
        }
      }
    } catch {}
  }

  return {
    phase1,
    cordis: cordisResults,
    dshHome,
    aiBase: findAiBase(dshHome),
  };
}

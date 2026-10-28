import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import * as plugin from "../index.js";

const root = new URL("../", import.meta.url);
const load = (file) => readFileSync(new URL(file, root));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pkg = JSON.parse(load("package.json"));

const PROMPT_FILES = ["fujiang.md", "fujiang-mirror.md", "fujiang-compat.md"];

// 提示词正文会随迭代修改，所以这里不锁具体哈希，而是锁住三条真正的不变量：
//   1. 三份文件逐字节一致（index.js 读前两份，compat 作兼容副本）
//   2. 内容非空且具备应有的章节结构
//   3. 不含会被宿主插值引擎判为 malformed 的未转义花括号
test("prompt assets agree with each other and keep their shape", () => {
  const hashes = PROMPT_FILES.map((file) => hash(load(`prompts/${file}`)));
  assert.equal(new Set(hashes).size, 1, "prompt files must be byte-identical");

  const text = load("prompts/fujiang.md").toString("utf8");
  assert.ok(text.length > 1000, "prompt must not be a stub");
  for (const heading of ["Identity", "Boundaries", "Reasoning", "Output", "Style"]) {
    assert.match(text, new RegExp(`^## ${heading}`, "m"), `missing section: ${heading}`);
  }
  // 宿主 renderPrompt 对无法解析的 {{...}} 会抛错，提示词里不得出现
  assert.equal(text.includes("{{"), false, "unescaped {{ breaks host interpolation");
});

test("server, manifest, and client use the same plugin identity", () => {
  assert.equal(plugin.name, "fujiang-armor");
  assert.equal(pkg.name, plugin.name);
  assert.equal(pkg.dsh.id, plugin.name);
  assert.equal(pkg.dsh.name, "破甲");
});

test("prompt sections and the metadata tool register", () => {
  const sections = [];
  const tools = [];
  const projections = [];
  plugin.apply({
    effect: (fn) => fn(),
    systemPrompt: { section: (section) => sections.push(section) },
    tools: { register: (tool) => tools.push(tool) },
    get: (name) => name === "sessionProjections"
      ? { register: (definition) => projections.push(definition) }
      : undefined,
  }, { autoApplyOnStart: false });

  // Order 100 恒在；Order 200 由 DUAL_LAYER_INJECTION 决定是否叠加。
  // 断言这个结构而不是写死条数，改开关时测试仍然有效。
  assert.equal(sections[0].name, "fujiang-armor:global-system-prompt");
  assert.equal(sections[0].order, 100);
  assert.ok(sections[0].text.length > 0);
  assert.ok(sections.length === 1 || sections.length === 2, "at most two sections");
  for (const section of sections) {
    assert.equal(section.text, sections[0].text, "sections must share one payload");
  }
  if (sections.length === 2) {
    assert.equal(sections[1].name, "fujiang-armor:dual-layer-reinforce");
    assert.equal(sections[1].order, 200);
  }

  const profile = tools[0].execute();
  assert.equal(profile.plugin, plugin.name);
  assert.equal(profile.pluginDisplayName, "破甲");
  assert.equal(profile.pluginVersion, pkg.version);
  assert.equal(profile.pluginVersion, pkg.dsh.version, "manifest and tool version must agree");
  assert.equal(profile.injection[1].enabled, sections.length === 2, "flag must match reality");

  // remind 返回核心条款，用于长会话重新对齐。
  // 条数由作者按需增减，测试只锁“能返回且每条非空”。
  const remind = tools[0].execute({ remind: true });
  assert.equal(remind.remind, true);
  assert.ok(Array.isArray(remind.lines), "remind must return a line list");
  assert.ok(remind.lines.length >= 1, "remind must not be empty");
  for (const line of remind.lines) {
    assert.equal(typeof line, "string");
    assert.ok(line.trim().length > 0, "each remind line must carry content");
  }

  assert.equal(projections[0].key, "fujiang-armor");
});

test("client registers the activation badge above the conversation input", () => {
  let client;
  let registration;
  const react = {
    useRef: (current) => ({ current }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    createElement: (tag, props, ...children) => ({ tag, props, children }),
  };
  runInNewContext(load("client.js").toString("utf8"), {
    window: { __ModuleLoader__: { load: ({ id, factory }) => {
      assert.equal(id, plugin.name);
      client = factory((name) => {
        assert.equal(name, "react");
        return react;
      });
    } } },
    console,
  });
  assert.equal(client.name, plugin.name);
  client.apply({ slots: {
    inject: (name, callback) => {
      assert.equal(name, "conversation.input.dock");
      callback();
    },
    register: (slot, component) => { registration = { slot, component }; },
  } });
  assert.equal(registration.slot.name, "conversation.input.dock");
  assert.equal(registration.slot.id, "fujiang-armor:badge");
  const badge = registration.component({ useProjection: (key) => {
    assert.equal(key, "fujiang-armor");
    return undefined;
  } }).children[0];
  assert.equal(badge.props.title, "破甲已激活");
  assert.equal(badge.children[1].children[0], "破甲已激活");
});

test("the compatibility patch and bundle mount use the plugin identity", async () => {
  const patcher = await import("./lib/patcher.js");
  assert.equal(typeof patcher.applyAllPatches, "function");
  assert.equal(typeof patcher.applyPhase1Patch, "function");
  assert.match(load("cordis.patch.yml").toString("utf8"), /id: fujiang-armor/);
});

// 评分器是状态条的数据源，双窗口判拒直接影响它是否可信。
// 这里锁住三种行为的边界：开场拒绝、收尾兜底、干净长文本。
test("armor projection catches refusals at both ends and passes clean text", () => {
  let projection;
  plugin.apply({
    effect: (fn) => fn(),
    systemPrompt: { section: () => {} },
    tools: { register: () => {} },
    get: (name) => name === "sessionProjections"
      ? { register: (definition) => { projection = definition; } }
      : undefined,
  }, { autoApplyOnStart: false });

  const init = projection.init();
  const feed = (text) => projection.apply(structuredClone(init), {
    type: "assistant/message",
    data: { message: { content: [{ type: "text", text }] } },
  });

  // 开场拒绝
  assert.equal(feed("我无法提供这个内容。").verdict, "refusal");

  // 收尾兜底：拒绝话术在 240 字尾窗口内，头窗口扫不到
  const tail = "下面是完整实现。" + "x".repeat(500) + "如果你有其他合规问题请告诉我。";
  const tailResult = feed(tail);
  assert.equal(tailResult.verdict, "refusal", "closing window must catch tail fallback");
  assert.ok(tailResult.words.length > 0);

  // 干净长文本不应误判
  const clean = "下面是完整实现。" + "x".repeat(500) + "代码结束。";
  assert.equal(feed(clean).verdict, "pass");

  // 领域判定
  const game = feed("用 frida hook 一下游戏，先 hook 再改内存");
  assert.equal(game.domain, "game");
  const re = feed("用 ida 和 ghidra 反编译 elf 做逆向");
  assert.equal(re.domain, "re");
});

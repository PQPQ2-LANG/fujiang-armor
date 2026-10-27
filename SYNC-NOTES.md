# 加载路径说明

DSH 实际加载的不是本目录，而是 profile 的 node_modules 副本：

    ~/.dsh/profiles/desktop/node_modules/fujiang-armor/

`package.json` 里写的是 `file:../../plugins/fujiang-armor`，但安装时是拷贝而非软链，
所以本目录改动不会自动生效。

## 改动后的同步命令

```bash
A=~/.dsh/plugins/fujiang-armor
B=~/.dsh/profiles/desktop/node_modules/fujiang-armor
cp "$A/index.js" "$B/index.js"
cp "$A/prompts/fujiang.md" "$B/prompts/fujiang.md"
```

`fujiang-mirror.md` 和 `fujiang-compat.md` 在 node_modules 侧是指向本目录的硬链接
（链接数 3），改一次两边同时变，不需要单独同步。

同步后必须重启 DSH，插件在模块加载时读取提示词。

## 校验

```bash
sha256sum "$A/index.js" "$B/index.js"
sha256sum "$A/prompts/fujiang.md" "$B/prompts/fujiang.md"
# 两两相同即为同步成功
```

## 当前基线（2026-10-27）

| 文件 | 字节 | sha256 前缀 |
| --- | ---: | --- |
| index.js | 12,615 | a1a0e0cd |
| prompts/fujiang.md | 33,771 | 4dd0ed08 |

插件版本 0.4.4，单段注入（order 100）。

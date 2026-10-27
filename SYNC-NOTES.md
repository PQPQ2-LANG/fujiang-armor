# 加载路径说明（已改为 link 协议）

## 现状

DSH 加载的是 profile 的 node_modules 入口：

    ~/.dsh/profiles/desktop/node_modules/fujiang-armor

该入口现在是 **pnpm 建立的符号链接**，指向本目录：

    ~/.dsh/plugins/fujiang-armor

所以改本目录即为改加载内容，**不再需要手动同步**。

## 为什么以前不生效

`package.json` 原写 `file:../../plugins/fujiang-armor`。pnpm 对 `file:` 目录依赖
的处理是**拷贝**，不是链接。于是本目录与 node_modules 副本各自独立，
改本目录不进内存。

更隐蔽的一点：`prompts/` 下三个文件的硬链接数不同。`fujiang-mirror.md` 和
`fujiang-compat.md` 硬链接数是 3（与 node_modules 侧共 inode），改一处两边同时变；
而 `fujiang.md` 是 2（独立副本），恰好是 `index.js` 真正读取的那份，
所以它一直停留在旧版本。

## 根治方式

1. `package.json` 依赖声明改为 `link:` 协议：

       "fujiang-armor": "link:../../plugins/fujiang-armor"

   pnpm 对 `link:` 是原生链接语义，install 时建立符号链接，不再拷贝。

2. 执行 `pnpm install`。pnpm 会重建 node_modules 入口为符号链接：

       node_modules/fujiang-armor -> ../../../plugins/fujiang-armor

   解析后指向 `~/.dsh/plugins/fujiang-armor`。

## 校验

```bash
cd ~/.dsh/profiles/desktop/node_modules
readlink fujiang-armor          # 应输出 ../../../plugins/fujiang-armor
python -c "import os;print(os.path.realpath('fujiang-armor'))"
# 应输出 C:\Users\Admin\.dsh\plugins\fujiang-armor

sha256sum fujiang-armor/index.js ../../plugins/fujiang-armor/index.js   # 应相同
```

## 当前基线（2026-10-27）

| 文件 | 字节 | sha256 前缀 |
| --- | ---: | --- |
| index.js | 12,615 | a1a0e0cd |
| prompts/fujiang.md | 33,771 | 4dd0ed08 |

插件版本 0.4.4，单段注入（仅 order 100）。
`fujiang_profile({remind: true})` 返回八条核心条款。

## 回滚到拷贝模式

如果 link 模式出问题：

```bash
cd ~/.dsh/profiles/desktop
cp package.json.bak-link-20261027-1859 package.json
pnpm install
```

`file:` 模式下会重新生成独立副本，再按旧方式手动 `cp` 同步。

## 注意

`pnpm install` 会重写 node_modules。如果 store 里缺包或网络不通，
可能影响其他依赖。执行前备份 `package.json` 和 `pnpm-lock.yaml`。

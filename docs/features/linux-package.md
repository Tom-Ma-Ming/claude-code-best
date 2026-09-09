# Linux 离线安装包

`bun run package:linux` 生成 `release/ccb-<version>-linux-x64.tar.gz`，自带 bun 运行时和 ripgrep，目标机不需要网络、不需要 Node.js。适用于 glibc 的 x86_64 Linux（Debian 11+、Ubuntu 20.04+、RHEL 8+）。

## 打包（在有网络的开发机上）

```bash
bun run package:linux              # 先 build:vite 再打包
bun run package:linux --no-build   # 复用现有 dist/
```

首次运行会把 bun（普通版 + baseline 版）和 ripgrep 的发布二进制下载到 `.cache/package/`，之后离线可重复打包。`BUN_VERSION`、`RG_VERSION`、`CCB_PKG_CACHE`、`CCB_PKG_OUT` 可覆盖。

包内容：

| 路径 | 说明 |
|---|---|
| `bin/ccb` | 启动器：定位安装目录，无 AVX2 的 CPU 自动改用 `bun-baseline` |
| `bin/bun`、`bin/bun-baseline` | 运行时 |
| `dist/` | 构建产物，`dist/vendor/ripgrep/x64-linux/rg` 已替换为 Linux 版 |
| `skills/` | devflow 的两个 skill，供 `ccb devflow skills install` 链接 |
| `install.sh` / `uninstall.sh` | 安装到 `/opt/ccb`（root）或 `~/.local/ccb`（普通用户） |
| `ccb-settings.example.json` | 用户级配置模板 |

## 安装（目标机）

```bash
tar xzf ccb-2.8.4-linux-x64.tar.gz
cd ccb-2.8.4-linux-x64
sudo ./install.sh                 # → /opt/ccb，软链 /usr/local/bin/ccb
# 或不用 root：
./install.sh --prefix ~/.local    # → ~/.local/ccb，软链 ~/.local/bin/ccb

mkdir -p ~/.ccb
cp /opt/ccb/ccb-settings.example.json ~/.ccb/settings.json
vi ~/.ccb/settings.json           # 填内网网关地址、token、模型名
ccb doctor
```

升级：解压新包再跑一次 `install.sh`，会原地替换 `/opt/ccb`，`~/.ccb` 不动。卸载：`/opt/ccb/uninstall.sh`。

建议目标机装上 `git`（`apt install git`），ccb 本身不依赖它，但仓库操作和 worktree 需要。

## 验证记录

在 `debian:12` 容器（x86_64）里实测：root 安装、`ccb --version`、vendored ripgrep 运行、`ccb devflow skills install`、通过内网网关的 `ccb -p` 无头对话、普通用户 `--prefix` 安装、卸载，全部通过。

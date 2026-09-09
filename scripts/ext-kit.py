#!/usr/bin/env python3
"""ccb extensions kit — back up every skill, plugin and helper tool installed
for ccb on this machine, and install them globally on an offline Linux box.

    # on the machine that has everything (macOS or Linux, needs npm for tools)
    python3 scripts/ext-kit.py backup [--out release] [--with-data] [--skip memorix,codegraph,node]

    # on the target (python3 only; no network)
    tar xzf ccb-extensions-<date>.tar.gz && cd ccb-extensions-<date>
    sudo python3 install.py                      # global: /opt/ccb-tools + /usr/local/bin
    python3 install.py --user                    # per-user: ~/.ccb/tools + ~/.local/bin

What goes in:
  skills/          union of ~/.ccb/skills, ~/.claude/skills, ~/.agents/skills (symlinks resolved)
  ecc/             the ECC library that skills/ecc-loader/catalog/ROOT points at
  plugins/         ~/.ccb/plugins cache + marketplaces + registries
  home/            settings.json, CLAUDE.md, RTK.md, hooks/
  tools/           Node.js (linux-x64), memorix (prod-only tree), codegraph (linux-x64)
  data/            only with --with-data: ~/.claude-mem, ~/.memorix

Standard library only, so the same file doubles as install.py inside the archive.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

KIT_VERSION = 1
NODE_MAJOR = "22"
CODEGRAPH_VERSION = "1.5.0"

# ---------------------------------------------------------------------------
# shared helpers


def log(msg: str) -> None:
    print(msg, flush=True)


def warn(msg: str) -> None:
    print(f"WARN: {msg}", file=sys.stderr, flush=True)


def home() -> Path:
    return Path(os.path.expanduser("~"))


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, text=True, **kw)


def copy_tree(src: Path, dst: Path, *, ignore=None) -> None:
    """Copy resolving symlinks, replacing dst. Skips dangling links instead of dying."""
    if dst.exists() or dst.is_symlink():
        if dst.is_dir() and not dst.is_symlink():
            shutil.rmtree(dst)
        else:
            dst.unlink()
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(
            src,
            dst,
            symlinks=False,
            ignore=ignore,
            ignore_dangling_symlinks=True,
            dirs_exist_ok=True,
        )
    else:
        shutil.copy2(src, dst)


def read_json(path: Path, default=None):
    if not path.exists():
        return default
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def rewrite_strings(value, replacements: list[tuple[str, str]]):
    """Recursively apply prefix replacements to every string in a JSON value."""
    if isinstance(value, str):
        for old, new in replacements:
            if old and old in value:
                value = value.replace(old, new)
        return value
    if isinstance(value, list):
        return [rewrite_strings(v, replacements) for v in value]
    if isinstance(value, dict):
        return {k: rewrite_strings(v, replacements) for k, v in value.items()}
    return value


def skill_dirs_in(root: Path) -> dict[str, Path]:
    found: dict[str, Path] = {}
    if not root.is_dir():
        return found
    for entry in sorted(root.iterdir()):
        if entry.name.startswith("."):
            continue
        target = entry.resolve()
        if target.is_dir() and (target / "SKILL.md").exists():
            found[entry.name] = target
    return found


# ---------------------------------------------------------------------------
# backup


def backup(args: argparse.Namespace) -> int:
    h = home()
    ccb = Path(os.environ.get("CCB_CONFIG_DIR") or (h / ".ccb"))
    skip = set(filter(None, (args.skip or "").split(",")))
    stamp = dt.date.today().isoformat()
    name = f"ccb-extensions-{stamp}"
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)

    stage_root = Path(tempfile.mkdtemp(prefix="ccb-ext-"))
    stage = stage_root / name
    stage.mkdir()
    manifest: dict = {
        "kit": KIT_VERSION,
        "createdAt": dt.datetime.now().isoformat(timespec="seconds"),
        "sourceHome": str(h),
        "sourceCcbHome": str(ccb),
        "sourceClaudeHome": str(h / ".claude"),
        "platform": platform.platform(),
        "contents": {},
    }

    # -- skills -----------------------------------------------------------
    skills: dict[str, Path] = {}
    for root in (ccb / "skills", h / ".claude" / "skills", h / ".agents" / "skills"):
        for sname, path in skill_dirs_in(root).items():
            skills.setdefault(sname, path)
    for sname, path in skills.items():
        copy_tree(path, stage / "skills" / sname, ignore=shutil.ignore_patterns(".git", "node_modules", "__pycache__"))
    manifest["contents"]["skills"] = sorted(skills)
    log(f"skills: {len(skills)}")

    # -- ECC library ------------------------------------------------------
    root_file = stage / "skills" / "ecc-loader" / "catalog" / "ROOT"
    if root_file.exists():
        ecc_src = Path(root_file.read_text(encoding="utf-8").strip()).expanduser()
        if ecc_src.is_dir():
            copy_tree(ecc_src, stage / "ecc" / ecc_src.name, ignore=shutil.ignore_patterns(".git", "node_modules"))
            manifest["contents"]["ecc"] = {"source": str(ecc_src), "name": ecc_src.name}
            log(f"ecc: {ecc_src}")
        else:
            warn(f"ecc-loader ROOT points at {ecc_src} which does not exist; ECC not included")

    # -- plugins ----------------------------------------------------------
    plugins = ccb / "plugins"
    if plugins.is_dir():
        for sub in ("cache", "marketplaces"):
            src = plugins / sub
            if src.is_dir():
                copy_tree(
                    src,
                    stage / "plugins" / sub,
                    ignore=shutil.ignore_patterns("temp_*", ".git", "*.log"),
                )
        for fname in ("installed_plugins.json", "known_marketplaces.json", "config.json", "blocklist.json"):
            if (plugins / fname).exists():
                shutil.copy2(plugins / fname, stage / "plugins" / fname)
        installed = read_json(plugins / "installed_plugins.json", {}).get("plugins", {})
        manifest["contents"]["plugins"] = sorted(installed)
        log(f"plugins: {len(installed)}")
    else:
        warn(f"{plugins} not found; no plugins included")

    # -- home files -------------------------------------------------------
    (stage / "home").mkdir()
    for fname in ("settings.json", "CLAUDE.md", "RTK.md"):
        if (ccb / fname).exists():
            shutil.copy2(ccb / fname, stage / "home" / fname)
    if (ccb / "hooks").is_dir():
        copy_tree(ccb / "hooks", stage / "home" / "hooks")
    settings = read_json(ccb / "settings.json", {})
    manifest["contents"]["settings"] = {
        "enabledPlugins": settings.get("enabledPlugins", {}),
        "hasEnv": bool(settings.get("env")),
    }
    node_path = shutil.which("node")
    manifest["sourceNode"] = os.path.realpath(node_path) if node_path else None

    # -- tools ------------------------------------------------------------
    tools = stage / "tools"
    tools.mkdir()
    if "node" not in skip:
        node_tar = fetch_node(cache)
        shutil.copy2(node_tar, tools / node_tar.name)
        manifest["contents"]["node"] = node_tar.name
    if "memorix" not in skip:
        memorix_src = find_memorix_source()
        if memorix_src:
            build_memorix_tree(memorix_src, tools / "memorix", cache)
            manifest["contents"]["memorix"] = read_json(memorix_src / "package.json", {}).get("version")
        else:
            warn("memorix not found on this machine (npm -g memorix); skipped")
    if "codegraph" not in skip:
        cg = fetch_codegraph(cache)
        (tools / "codegraph").mkdir()
        for p in cg:
            shutil.copy2(p, tools / "codegraph" / p.name)
        manifest["contents"]["codegraph"] = CODEGRAPH_VERSION

    # -- data (optional) --------------------------------------------------
    if args.with_data:
        for src, dst in ((h / ".claude-mem", "claude-mem"), (h / ".memorix", "memorix")):
            if src.is_dir():
                copy_tree(src, stage / "data" / dst, ignore=shutil.ignore_patterns("logs", "*.log", "*.log.prev", "backups"))
                manifest["contents"].setdefault("data", []).append(dst)
                log(f"data: {src}")

    # -- kit itself -------------------------------------------------------
    shutil.copy2(Path(__file__).resolve(), stage / "install.py")
    (stage / "README.md").write_text(README, encoding="utf-8")
    write_json(stage / "manifest.json", manifest)

    # -- archive ----------------------------------------------------------
    archive = out_dir / f"{name}.tar.gz"
    log("compressing…")
    env = {**os.environ, "COPYFILE_DISABLE": "1"}
    tar_args = ["tar", "-C", str(stage_root), "-czf", str(archive)]
    if sys.platform == "darwin":
        tar_args[1:1] = ["--no-xattrs", "--no-fflags"]
    run(tar_args + [name], env=env)
    shutil.rmtree(stage_root)
    size_mb = archive.stat().st_size / 1e6
    log(f"wrote {archive} ({size_mb:.0f} MB)")
    return 0


def fetch_node(cache: Path) -> Path:
    existing = sorted(cache.glob(f"node-v{NODE_MAJOR}.*-linux-x64.tar.xz"))
    if existing:
        return existing[-1]
    import urllib.request

    log("resolving latest Node 22…")
    with urllib.request.urlopen("https://nodejs.org/dist/index.json", timeout=60) as r:
        index = json.load(r)
    version = next(v["version"] for v in index if v["version"].startswith(f"v{NODE_MAJOR}."))
    dest = cache / f"node-{version}-linux-x64.tar.xz"
    log(f"downloading {dest.name}…")
    urllib.request.urlretrieve(f"https://nodejs.org/dist/{version}/{dest.name}", dest)
    return dest


def find_memorix_source() -> Path | None:
    exe = shutil.which("memorix")
    if not exe:
        return None
    real = Path(os.path.realpath(exe))
    # <pkg>/dist/cli/index.js → <pkg>
    for parent in real.parents:
        if (parent / "package.json").exists() and read_json(parent / "package.json", {}).get("name") == "memorix":
            return parent
    return None


def build_memorix_tree(src: Path, dest: Path, cache: Path) -> None:
    """npm pack + production-only install → a node_modules tree with no dev deps
    and (verified) no native modules, so it runs on Linux as-is."""
    version = read_json(src / "package.json", {}).get("version", "0")
    cached = cache / f"memorix-{version}-prod"
    if not (cached / "node_modules" / "memorix" / "package.json").exists():
        log(f"packing memorix {version} (production deps only)…")
        with tempfile.TemporaryDirectory() as tmp:
            run(["npm", "pack", str(src)], cwd=tmp, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            tgz = next(Path(tmp).glob("memorix-*.tgz"))
            if cached.exists():
                shutil.rmtree(cached)
            cached.mkdir(parents=True)
            write_json(cached / "package.json", {"name": "ccb-memorix-host", "private": True})
            run(
                ["npm", "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", str(tgz)],
                cwd=cached,
            )
    natives = [p for p in cached.rglob("*.node") if "prebuilds" not in p.parts]
    if natives:
        warn(f"memorix tree has native modules built for this OS: {natives[:3]} — may not run on Linux")
    copy_tree(cached, dest)
    log(f"memorix: {version}")


def fetch_codegraph(cache: Path) -> list[Path]:
    names = [
        f"colbymchenry-codegraph-{CODEGRAPH_VERSION}.tgz",
        f"colbymchenry-codegraph-linux-x64-{CODEGRAPH_VERSION}.tgz",
    ]
    missing = [n for n in names if not (cache / n).exists()]
    if missing:
        log("fetching codegraph packages…")
        run(
            ["npm", "pack", f"@colbymchenry/codegraph@{CODEGRAPH_VERSION}", f"@colbymchenry/codegraph-linux-x64@{CODEGRAPH_VERSION}"],
            cwd=cache,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    return [cache / n for n in names]


# ---------------------------------------------------------------------------
# install


def install(args: argparse.Namespace) -> int:
    kit = Path(__file__).resolve().parent
    manifest = read_json(kit / "manifest.json")
    if not manifest:
        print("manifest.json not found next to install.py — run this from the unpacked archive", file=sys.stderr)
        return 1
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "amd64"):
        warn(f"tools are built for Linux x86_64; this is {platform.system()} {platform.machine()} — skills/plugins install, tools skipped")
        args.no_tools = True

    h = home()
    ccb = Path(args.home).expanduser() if args.home else Path(os.environ.get("CCB_CONFIG_DIR") or (h / ".ccb"))
    is_root = os.geteuid() == 0
    global_install = not args.user and is_root
    tools_dir = Path(args.tools_dir) if args.tools_dir else (Path("/opt/ccb-tools") if global_install else ccb / "tools")
    bin_dir = Path(args.bin_dir) if args.bin_dir else (Path("/usr/local/bin") if global_install else h / ".local" / "bin")
    if not global_install and not args.user and not is_root:
        log("not root → per-user install (use sudo for a system-wide one)")

    ccb.mkdir(parents=True, exist_ok=True)
    src_paths = [manifest["sourceClaudeHome"], manifest["sourceCcbHome"]]
    node_bin = tools_dir / "node" / "bin" / "node"
    replacements: list[tuple[str, str]] = []
    for old in src_paths:
        replacements.append((old + "/plugins", str(ccb / "plugins")))
        replacements.append((old, str(ccb)))
    if manifest.get("sourceNode"):
        replacements.append((manifest["sourceNode"], str(node_bin)))
    replacements.append((manifest["sourceHome"], str(h)))
    # Shell-style references that survive a home change but not a config-dir rename.
    if ccb == h / ".ccb":
        for form in ('"$HOME"/.claude', "$HOME/.claude", "${HOME}/.claude", "~/.claude"):
            replacements.append((form, form.replace(".claude", ".ccb")))

    # -- skills -----------------------------------------------------------
    skills_src = kit / "skills"
    count = 0
    if skills_src.is_dir():
        for entry in sorted(skills_src.iterdir()):
            if entry.is_dir():
                copy_tree(entry, ccb / "skills" / entry.name)
                count += 1
    log(f"skills → {ccb / 'skills'} ({count})")

    # -- ECC --------------------------------------------------------------
    ecc = manifest["contents"].get("ecc")
    if ecc and (kit / "ecc" / ecc["name"]).is_dir():
        ecc_dst = ccb / "ecc" / ecc["name"]
        copy_tree(kit / "ecc" / ecc["name"], ecc_dst)
        for sname in ("ecc-loader", "ecc-orchestrator"):
            root_file = ccb / "skills" / sname / "catalog" / "ROOT"
            if root_file.exists():
                root_file.write_text(str(ecc_dst) + "\n", encoding="utf-8")
        log(f"ecc → {ecc_dst}")

    # -- plugins ----------------------------------------------------------
    plugins_src = kit / "plugins"
    if plugins_src.is_dir():
        plugins_dst = ccb / "plugins"
        for sub in ("cache", "marketplaces"):
            if (plugins_src / sub).is_dir():
                copy_tree(plugins_src / sub, plugins_dst / sub)
        for fname in ("installed_plugins.json", "known_marketplaces.json", "config.json", "blocklist.json"):
            data = read_json(plugins_src / fname)
            if data is not None:
                write_json(plugins_dst / fname, rewrite_strings(data, replacements))
        installed = read_json(plugins_src / "installed_plugins.json", {}).get("plugins", {})
        log(f"plugins → {plugins_dst} ({len(installed)})")

    # -- settings ---------------------------------------------------------
    src_settings = read_json(kit / "home" / "settings.json", {})
    src_settings = rewrite_strings(src_settings, replacements)
    settings_path = ccb / "settings.json"
    target = read_json(settings_path, {})
    if args.overwrite_settings or not target:
        merged = src_settings
    else:
        merged = merge_settings(target, src_settings)
    if settings_path.exists():
        shutil.copy2(settings_path, settings_path.with_suffix(".json.bak-ext-kit"))
    write_json(settings_path, merged)
    log(f"settings → {settings_path} ({'overwritten' if args.overwrite_settings or not target else 'merged'})")

    for fname in ("CLAUDE.md", "RTK.md"):
        src = kit / "home" / fname
        if src.exists() and (args.force or not (ccb / fname).exists()):
            shutil.copy2(src, ccb / fname)
    if (kit / "home" / "hooks").is_dir():
        copy_tree(kit / "home" / "hooks", ccb / "hooks")

    # -- tools ------------------------------------------------------------
    if not args.no_tools:
        tools_dir.mkdir(parents=True, exist_ok=True)
        bin_dir.mkdir(parents=True, exist_ok=True)
        install_tools(kit, manifest, tools_dir, bin_dir)

    # -- data -------------------------------------------------------------
    if (kit / "data").is_dir():
        for entry in (kit / "data").iterdir():
            dst = h / f".{entry.name}"
            if dst.exists() and not args.force:
                warn(f"{dst} exists; skipping data restore (use --force)")
                continue
            copy_tree(entry, dst)
            log(f"data → {dst}")

    # -- report -----------------------------------------------------------
    log("")
    verify(ccb, bin_dir, tools_dir, args.no_tools)
    if str(bin_dir) not in os.environ.get("PATH", "").split(":"):
        warn(f"{bin_dir} is not on PATH")
    return 0


def merge_settings(target: dict, src: dict) -> dict:
    merged = dict(target)
    for key in ("enabledPlugins", "extraKnownMarketplaces"):
        merged[key] = {**target.get(key, {}), **src.get(key, {})}
    # hooks: union per event, de-duplicated by command
    hooks = {k: list(v) for k, v in target.get("hooks", {}).items()}
    for event, groups in src.get("hooks", {}).items():
        existing = json.dumps(hooks.get(event, []), sort_keys=True)
        for group in groups:
            if json.dumps(group, sort_keys=True) not in existing:
                hooks.setdefault(event, []).append(group)
    if hooks:
        merged["hooks"] = hooks
    perms = dict(target.get("permissions", {}))
    allow = list(dict.fromkeys(perms.get("allow", []) + src.get("permissions", {}).get("allow", [])))
    if allow:
        perms["allow"] = allow
        merged["permissions"] = perms
    for key in ("statusLine", "enableWorkflows", "alwaysThinkingEnabled", "skipDangerousModePermissionPrompt"):
        if key in src and key not in target:
            merged[key] = src[key]
    if "env" not in target and "env" in src:
        merged["env"] = src["env"]
    if "model" not in target and "model" in src:
        merged["model"] = src["model"]
    return merged


def install_tools(kit: Path, manifest: dict, tools_dir: Path, bin_dir: Path) -> None:
    tools = kit / "tools"
    node_tar = manifest["contents"].get("node")
    node_dir = tools_dir / "node"
    if node_tar and (tools / node_tar).exists():
        if node_dir.exists():
            shutil.rmtree(node_dir)
        with tempfile.TemporaryDirectory() as tmp:
            with tarfile.open(tools / node_tar) as tf:
                tf.extractall(tmp, filter="tar")
            extracted = next(Path(tmp).glob("node-v*"))
            shutil.move(str(extracted), node_dir)
        for name in ("node", "npm", "npx"):
            link(node_dir / "bin" / name, bin_dir / name)
        log(f"node → {node_dir}")

    if (tools / "memorix").is_dir():
        copy_tree(tools / "memorix", tools_dir / "memorix")
        for name in ("memorix", "memcode"):
            entry = tools_dir / "memorix" / "node_modules" / "memorix" / "dist" / "cli" / ("index.js" if name == "memorix" else "memcode.js")
            wrapper(bin_dir / name, node_dir / "bin" / "node", entry)
        log(f"memorix → {tools_dir / 'memorix'}")

    cg_dir = tools_dir / "codegraph"
    tgzs = sorted((tools / "codegraph").glob("*.tgz")) if (tools / "codegraph").is_dir() else []
    if tgzs:
        if cg_dir.exists():
            shutil.rmtree(cg_dir)
        for tgz in tgzs:
            pkg = "codegraph-linux-x64" if "linux-x64" in tgz.name else "codegraph"
            dest = cg_dir / "node_modules" / "@colbymchenry" / pkg
            dest.mkdir(parents=True)
            with tarfile.open(tgz) as tf:
                with tempfile.TemporaryDirectory() as tmp:
                    tf.extractall(tmp, filter="tar")
                    for item in (Path(tmp) / "package").iterdir():
                        shutil.move(str(item), dest / item.name)
        shim = cg_dir / "node_modules" / "@colbymchenry" / "codegraph" / "npm-shim.js"
        wrapper(bin_dir / "codegraph", node_dir / "bin" / "node", shim)
        log(f"codegraph → {cg_dir}")

    # claude-mem's hooks call `bun`; the ccb package ships one.
    for candidate in (Path("/opt/ccb/bin/bun"), home() / ".local" / "ccb" / "bin" / "bun"):
        if candidate.exists() and not (bin_dir / "bun").exists():
            link(candidate, bin_dir / "bun")
            break


def link(target: Path, at: Path) -> None:
    if at.is_symlink() or at.exists():
        at.unlink()
    at.symlink_to(target)


def wrapper(at: Path, node: Path, script: Path) -> None:
    at.write_text(f'#!/bin/sh\nexec "{node}" "{script}" "$@"\n', encoding="utf-8")
    at.chmod(0o755)


def verify(ccb: Path, bin_dir: Path, tools_dir: Path, no_tools: bool) -> None:
    def ok(good: bool, label: str) -> None:
        log(f"  {'✓' if good else '✗'} {label}")

    log("verification:")
    skills = [p for p in (ccb / "skills").iterdir() if (p / "SKILL.md").exists()] if (ccb / "skills").is_dir() else []
    ok(bool(skills), f"skills: {len(skills)} in {ccb / 'skills'}")
    installed = read_json(ccb / "plugins" / "installed_plugins.json", {}).get("plugins", {})
    broken = [pid for pid, entries in installed.items() if not all(Path(e["installPath"]).is_dir() for e in entries)]
    ok(not broken, f"plugins: {len(installed)} registered, {len(broken)} with missing installPath {broken if broken else ''}")
    ecc_root = ccb / "skills" / "ecc-loader" / "catalog" / "ROOT"
    if ecc_root.exists():
        ok(Path(ecc_root.read_text().strip()).is_dir(), f"ecc: {ecc_root.read_text().strip()}")
    if not no_tools:
        for name in ("node", "memorix", "codegraph"):
            exe = bin_dir / name
            try:
                out = subprocess.run([str(exe), "--version"], capture_output=True, text=True, timeout=60)
                ok(out.returncode == 0, f"{name}: {(out.stdout or out.stderr).strip().splitlines()[0] if (out.stdout or out.stderr).strip() else 'no output'}")
            except Exception as e:  # noqa: BLE001
                ok(False, f"{name}: {e}")
    ccb_exe = shutil.which("ccb")
    if ccb_exe:
        try:
            out = subprocess.run([ccb_exe, "plugin", "list"], capture_output=True, text=True, timeout=120)
            lines = [l for l in out.stdout.splitlines() if l.strip()]
            ok(out.returncode == 0 and "No plugins" not in out.stdout, f"ccb plugin list: {len(lines)} lines")
        except Exception as e:  # noqa: BLE001
            ok(False, f"ccb plugin list: {e}")
    else:
        log("  · ccb not on PATH — install the ccb package first, then re-run to verify plugins")


README = """# ccb extensions — offline kit

    sudo python3 install.py            # system-wide: ~/.ccb of the invoking user + /opt/ccb-tools + /usr/local/bin
    python3 install.py --user          # per-user: ~/.ccb + ~/.ccb/tools + ~/.local/bin

Options: --home DIR (ccb config dir), --tools-dir DIR, --bin-dir DIR,
--overwrite-settings (replace settings.json instead of merging), --no-tools,
--force (overwrite CLAUDE.md/RTK.md and data dirs).

Install the ccb package first so `bun` and `ccb` exist; the verification step
at the end runs `ccb plugin list`.

NOTE: with sudo, "~" is root's home unless you pass --home /home/<user>/.ccb.
The usual pattern for a developer machine is:

    sudo python3 install.py --home /home/dev/.ccb && sudo chown -R dev:dev /home/dev/.ccb
"""


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd")

    b = sub.add_parser("backup", help="create the archive on the source machine")
    b.add_argument("--out", default="release")
    b.add_argument("--cache", default=".cache/package")
    b.add_argument("--with-data", action="store_true", help="include ~/.claude-mem and ~/.memorix")
    b.add_argument("--skip", default="", help="comma list of tools to skip: node,memorix,codegraph")

    i = sub.add_parser("install", help="install from the unpacked archive on the target")
    add_install_args(i)

    # `python3 install.py` inside the archive defaults to install.
    if Path(__file__).name == "install.py" and (not argv or argv[0].startswith("-")):
        argv = ["install", *argv]
    args = parser.parse_args(argv)
    if args.cmd == "backup":
        return backup(args)
    if args.cmd == "install":
        return install(args)
    parser.print_help()
    return 1


def add_install_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--home", help="ccb config dir (default: $CCB_CONFIG_DIR or ~/.ccb)")
    p.add_argument("--user", action="store_true", help="per-user tools/bin even when root")
    p.add_argument("--tools-dir")
    p.add_argument("--bin-dir")
    p.add_argument("--overwrite-settings", action="store_true")
    p.add_argument("--no-tools", action="store_true")
    p.add_argument("--force", action="store_true")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

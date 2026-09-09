# ccb — Linux x86_64 offline package

Self-contained: bundles the bun runtime and ripgrep, needs no network and no
system Node.js. Requires glibc-based Linux (Debian 11+, Ubuntu 20.04+, RHEL 8+).

    tar xzf ccb-<version>-linux-x64.tar.gz
    cd ccb-<version>-linux-x64
    sudo ./install.sh              # or: ./install.sh --prefix ~/.local

Then create ~/.ccb/settings.json from ccb-settings.example.json and run
`ccb doctor`. Uninstall with `/opt/ccb/uninstall.sh`.

Layout: bin/ (bun, bun-baseline, ccb launcher), dist/ (CLI + vendor/ripgrep),
skills/ (devflow skills for `ccb devflow skills install`).

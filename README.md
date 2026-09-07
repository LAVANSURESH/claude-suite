Manual install (standard for GNOME Shell extensions):

git clone <your-repo-url> claude-suite
UUID=$(grep -o '"uuid": *"[^"]*"' claude-suite/metadata.json | cut -d'"' -f4)
mkdir -p ~/.local/share/gnome-shell/extensions/"$UUID"
cp -r claude-suite/* ~/.local/share/gnome-shell/extensions/"$UUID"/

Then:
- X11: press Alt+F2, type r, hit Enter to reload GNOME Shell.
- Wayland: log out and log back in (Shell can't be reloaded in-session).

Enable it:
gnome-extensions enable <uuid>
or via the Extensions app / gnome-extensions-app.

A few notes worth putting in your repo's README:
- The extension's folder name on disk must exactly match the uuid field in metadata.json — that's why the snippet above extracts it automatically rather than hardcoding a name.
- Check metadata.json's shell-version field lists versions compatible with what you're targeting — GNOME will refuse to load it otherwise.
- If you want it easily discoverable/updatable by others without manual copying, consider also publishing it to https://extensions.gnome.org (requires review) — but the manual method above works immediately from git.
=======
# Claude Suite

One panel menu for Claude Code: switch accounts (cswap), view local usage stats, and run pipeline scenarios (background or terminal).

A GNOME Shell extension. Compatible with GNOME Shell versions 45, 46, 47, 48.

## Installation

Clone the repo and copy it into your GNOME Shell extensions directory using its UUID:

```bash
git clone https://github.com/LAVANSURESH/claude-suite.git
UUID=$(grep -o '"uuid": *"[^"]*"' claude-suite/metadata.json | cut -d'"' -f4)
mkdir -p ~/.local/share/gnome-shell/extensions/"$UUID"
cp -r claude-suite/* ~/.local/share/gnome-shell/extensions/"$UUID"/
```

> The folder name on disk must exactly match the `uuid` field in `metadata.json` (`claude-suite@lavansuresh.github.io`). The commands above extract it automatically rather than hardcoding it.

### Reload GNOME Shell

- **X11**: Press `Alt+F2`, type `r`, press Enter.
- **Wayland**: Log out and log back in (GNOME Shell can't be reloaded in-session).

### Enable the extension

```bash
gnome-extensions enable claude-suite@lavansuresh.github.io
```

Or enable it via the **Extensions** app (`gnome-extensions-app`).

## Uninstall

```bash
gnome-extensions disable claude-suite@lavansuresh.github.io
rm -rf ~/.local/share/gnome-shell/extensions/claude-suite@lavansuresh.github.io
```

# dotfiles

Personal configuration for an Arch Linux laptop (GNOME on Wayland, zsh, Ghostty), managed with [chezmoi](https://www.chezmoi.io/).

## What's here

| Area | Files |
|---|---|
| Shell | `.zshrc`, `.zshenv` (PATH, react-doctor memory limits), `.bashrc`, `.bash_profile` |
| Terminal | Ghostty config (JetBrainsMono Nerd Font, background instance) |
| fastfetch | `auto.sh` (logo sized to terminal width), `cf-info.sh` (Cloudflare WARP / DNS status lines) |
| Git | SSH commit signing; identity lives in an unpublished `~/.gitconfig.local` |
| Tools | npm user prefix, makepkg (all threads, no `-debug` pkgs), mpv, default terminal |
| systemd user units | weekly Docker prune, Obsidian vault auto-backup, hourly dotfiles sync, Agentic Inbox mail notifier |
| Scripts | `~/.local/bin`: `obsidian-backup[-watch]`, `dotfiles-sync`, `dotfiles-push`; `~/.local/share/agentic-inbox-notifier/notifier.mjs` (desktop notifications for new mail; deployments in an unpublished config, Access tokens in GNOME Keyring) |

### zsh setup
Light plugin setup without a framework: zsh-autosuggestions, zsh-syntax-highlighting, starship, fzf (with fd + bat previews), zoxide, direnv, mise and uv. Each integration is skipped if its tool isn't installed.

## Install on a new machine

```bash
sudo pacman -S --needed chezmoi git github-cli zsh zsh-autosuggestions zsh-syntax-highlighting \
  zsh-completions starship fzf zoxide fd bat eza direnv mise uv ghostty ttf-jetbrains-mono-nerd fastfetch
chezmoi init --apply llegomark
```

Then create `~/.gitconfig.local` with your own identity:

```ini
[user]
	name = Your Name
	email = you@example.com
```

## Workflow

- Edit configs in place as usual.
- `dotfiles-sync` (hourly) records changes as **local** commits.
- `dotfiles-push` shows what changed, scans it with gitleaks, and publishes only after confirmation.
- New files: `chezmoi add <file>`.

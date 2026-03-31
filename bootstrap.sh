#!/usr/bin/env bash
set -euo pipefail

# Bootstrap pi-mono config into ~/.pi/agent/
# Symlinks files from home/ to ~, following the dotfiles pattern.

cd "$(dirname "${BASH_SOURCE[0]}")"

REPO_DIR="$(pwd)"

symlink_home() {
	while IFS= read -r -d '' src_file; do
		local rel_path="${src_file#$REPO_DIR/home/}"
		local dest_file="$HOME/$rel_path"

		mkdir -p "$(dirname "$dest_file")"

		# Skip if already correctly symlinked
		if [[ -L "$dest_file" && "$(readlink "$dest_file")" == "$src_file" ]]; then
			continue
		fi

		# Back up existing file if not a symlink
		if [[ -e "$dest_file" && ! -L "$dest_file" ]]; then
			echo "Backing up: ~/$rel_path -> ~/${rel_path}.bak"
			mv "$dest_file" "${dest_file}.bak"
		fi

		# Remove stale symlink
		if [[ -L "$dest_file" ]]; then
			rm -f "$dest_file"
		fi

		ln -s "$src_file" "$dest_file"
		echo "Linked: ~/$rel_path"
	done < <(find "$REPO_DIR/home" -type f -not -name ".DS_Store" -print0)
}

symlink_home
echo "Done."

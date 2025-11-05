# convert-nuget

Recursively searches for `packages.config` files and converts each to `packages.lock.json`. The generated files are created in the same directory as each discovered `packages.config` file.

## Manual Usage

```bash
node convert-nuget.js [--tfm <TFM>] [--root <DIR>]

# Example: scan from current directory
node convert-nuget.js

# Example: scan with custom target framework
node convert-nuget.js --tfm net48

# Example: scan from a specific directory
node convert-nuget.js --root ./projects
```

## Local Docker Usage

Pull the Docker image from GitHub Container Registry and run it locally:

```bash
# Pull the latest image
docker pull ghcr.io/semgrep/convert-nuget

# Run the conversion (scan from current directory)
docker run --rm -v $(pwd):/workspace -w /workspace ghcr.io/semgrep/convert-nuget

# Run the conversion (scan from a specific subdirectory)
docker run --rm -v $(pwd):/workspace -w /workspace ghcr.io/semgrep/convert-nuget --root /workspace/some/subdirectory

# Run with custom target framework
docker run --rm -v $(pwd):/workspace -w /workspace ghcr.io/semgrep/convert-nuget --tfm net48
```

## Docker CI Usage

```yaml
# GitHub Actions example
- name: Convert packages.config
  run: |
    docker run -v ${{ github.workspace }}:/workspace -w /workspace ghcr.io/semgrep/convert-nuget

# GitLab CI example
convert-nuget:
  script:
    - docker run -v $PWD:/workspace -w /workspace ghcr.io/semgrep/convert-nuget
```

```bash
# Command line
docker run -v $(pwd):/workspace -w /workspace ghcr.io/semgrep/convert-nuget
```

## GitHub Actions Usage

To automatically update & check in any changes made to packages.config, use the below action

```yaml
name: Convert packages.config to packages.lock.json
on:
  push:
    paths:
      - '**/packages.config'

permissions:
  contents: write  # needed to push commits

jobs:
  convert-nuget:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repo
        uses: actions/checkout@v4
        with:
          fetch-depth: 0   # so we can push back to the same ref

      - name: Convert packages.config
        run: |
          docker run -v "${{ github.workspace }}:/workspace" -w /workspace ghcr.io/semgrep/convert-nuget

      - name: Commit updated lock files (if any)
        run: |
          set -euo pipefail

          # make the workspace safe for git (sometimes needed in CI)
          git config --global --add safe.directory "$GITHUB_WORKSPACE"

          # author details for the commit
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

          # stage only lock files that changed/appeared
          CHANGED=$(git status --porcelain -- '**/packages.lock.json' | wc -l)
          if [ "$CHANGED" -gt 0 ]; then
            git add **/packages.lock.json
            git commit -m "chore(convert-nuget): update lock files after packages.config change"
            git push
            echo "Committed and pushed lock file updates."
          else
            echo "No lock file changes to commit."
          fi
```

## Options

- `--tfm <TFM>`: Target framework moniker (default: `net472`)
- `--root <DIR>`: Root directory to search (default: current working directory)
- `-h, --help`: Show help message

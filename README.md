# convert-nuget

Recursively searches for `packages.config` files and converts each to `packages.lock.json`. The generated files are created in the same directory as each discovered `packages.config` file.

## How It Works

The script processes each `packages.config` file using one of two methods:

1. **If a `.csproj` file exists** in the same directory as `packages.config`:
   - Uses the existing `.csproj` file and runs `dotnet restore` on it
   - Copies the generated `packages.lock.json` from the project directory or `obj/` subdirectory
   - If multiple `.csproj` files are found in the same directory, the script will error out (only one `.csproj` per directory is supported)

2. **If no `.csproj` file exists** (fallback mode):
   - Generates a temporary `.csproj` file from the packages listed in `packages.config`
   - Uses the target framework from `packages.config` (if specified) or the `--tfm` option
   - Automatically skips packages that are incompatible with the target framework
   - Generates `packages.lock.json` from the temporary project

### Package Skipping

When using the fallback mode (temporary `.csproj` generation), packages that are incompatible with the target framework are automatically skipped. By default, skipped packages are logged as warnings and the conversion continues. Use the `--fail-on-skipped` option to exit with error code 2 if any packages are skipped.

**Note**: Package skipping only occurs in fallback mode. When using an existing `.csproj` file, all packages in `packages.config` are expected to be compatible with the project's target framework.

## Manual Usage

```bash
node convert-nuget.js [--tfm <TFM>] [--root <DIR>] [--fail-on-skipped]

# Example: scan from current directory
node convert-nuget.js

# Example: scan with custom target framework
node convert-nuget.js --tfm net48

# Example: scan from a specific directory
node convert-nuget.js --root ./projects

# Example: fail if any packages are skipped due to incompatibility (fallback mode only)
node convert-nuget.js --fail-on-skipped
```

## Local Docker Usage

Pull the Docker image from GitHub Container Registry and run it locally:

```bash
# Pull the latest image
docker pull ghcr.io/semgrep/convert-nuget

# Run the conversion (scan from current directory)
# Note: -w /workspace is optional since /workspace is the default working directory
docker run --rm -v $(pwd):/workspace ghcr.io/semgrep/convert-nuget

# Run the conversion (scan from a specific subdirectory)
docker run --rm -v $(pwd):/workspace ghcr.io/semgrep/convert-nuget --root /workspace/some/subdirectory

# Run with custom target framework
docker run --rm -v $(pwd):/workspace ghcr.io/semgrep/convert-nuget --tfm net48
```

## Options

- `--tfm <TFM>`: Target framework moniker (default: `net472`)
  - Used when no `.csproj` file exists and no `targetFramework` is specified in `packages.config`
  - Ignored when an existing `.csproj` file is found (the project's target framework is used instead)

- `--root <DIR>`: Root directory to search (default: current working directory)
  - Recursively searches for all `packages.config` files starting from this directory

- `--fail-on-skipped`: Exit with error code 2 if any packages are skipped due to incompatibility
  - Only applies when using fallback mode (temporary `.csproj` generation)
  - By default, skipped packages are logged as warnings and conversion continues
  - Use this option in CI/CD pipelines to fail builds when packages are skipped

- `-h, --help`: Show help message

## Docker CI Usage

```yaml
# GitHub Actions example
- name: Convert packages.config
  run: |
    docker run -v ${{ github.workspace }}:/workspace ghcr.io/semgrep/convert-nuget

# GitLab CI example
convert-nuget:
  script:
    - docker run -v $PWD:/workspace ghcr.io/semgrep/convert-nuget
```

```bash
# Command line (note: -w /workspace is optional)
docker run -v $(pwd):/workspace ghcr.io/semgrep/convert-nuget
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
          docker run -v "${{ github.workspace }}:/workspace" ghcr.io/semgrep/convert-nuget

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
  - Used when no `.csproj` file exists and no `targetFramework` is specified in `packages.config`
  - Ignored when an existing `.csproj` file is found (the project's target framework is used instead)

- `--root <DIR>`: Root directory to search (default: current working directory)
  - Recursively searches for all `packages.config` files starting from this directory

- `--fail-on-skipped`: Exit with error code 2 if any packages are skipped due to incompatibility
  - Only applies when using fallback mode (temporary `.csproj` generation)
  - By default, skipped packages are logged as warnings and conversion continues
  - Use this option in CI/CD pipelines to fail builds when packages are skipped

- `-h, --help`: Show help message

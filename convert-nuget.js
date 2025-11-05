#!/usr/bin/env node
/**
 * convert-nuget: Converts packages.config files to packages.lock.json recursively
 * Supports monorepo structures by processing all packages.config files in a directory tree
 */

const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_TFM = 'net472';

function parseArgs() {
  const args = process.argv.slice(2);
  let tfm = DEFAULT_TFM;
  let rootDir = process.cwd();

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--tfm':
        if (!args[i + 1]) {
          console.error('Error: --tfm requires a value');
          process.exit(2);
        }
        tfm = args[++i];
        break;
      case '--root':
        if (!args[i + 1]) {
          console.error('Error: --root requires a value');
          process.exit(2);
        }
        rootDir = args[++i];
        break;
      case '-h':
      case '--help':
        console.log(`Usage: convert-nuget.js [--tfm <TFM>] [--root <DIR>]

Recursively finds all packages.config files starting from the current directory
(or --root if specified) and generates a packages.lock.json next to each one.

Options:
  --tfm <TFM>    Target framework moniker (default: ${DEFAULT_TFM})
  --root <DIR>   Root directory to search (default: current working directory)
  -h, --help     Show this help message`);
        process.exit(0);
      default:
        console.error(`Error: Unknown option: ${args[i]}`);
        process.exit(2);
    }
  }

  return { tfm, rootDir };
}

async function findPackagesConfigFiles(rootDir) {
  const files = [];
  
  async function walk(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.name === 'packages.config') {
          files.push(fullPath);
        }
      }
    } catch (err) {
      // Skip directories we can't read
    }
  }
  
  await walk(rootDir);
  return files;
}

async function parsePackagesConfig(packagesConfigPath) {
  const xml = await fs.readFile(packagesConfigPath, 'utf8');
  const packages = [];

  // Simple regex-based XML parsing (for packages.config specifically)
  // More robust than parsing full XML for this simple case
  const packageRegex = /<package\s+id="([^"]+)"\s+version="([^"]+)"[^>]*>/gi;
  let match;
  while ((match = packageRegex.exec(xml)) !== null) {
    packages.push({
      id: match[1],
      version: match[2],
    });
  }

  return packages;
}

function generatePackageReferences(packages) {
  return packages
    .map((pkg) => `    <PackageReference Include="${pkg.id}" Version="${pkg.version}" />`)
    .join('\n');
}

function generateCsproj(packages, tfm) {
  const packageRefs = generatePackageReferences(packages);
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>${tfm}</TargetFramework>
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
  </PropertyGroup>
  <ItemGroup>
${packageRefs}
  </ItemGroup>
</Project>`;
}

async function processPackagesConfig(packagesConfigPath, tfm) {
  const lockFilePath = path.join(
    path.dirname(packagesConfigPath),
    'packages.lock.json'
  );

  console.log(`Processing: ${packagesConfigPath}`);

  try {
    // Parse packages.config
    const packages = await parsePackagesConfig(packagesConfigPath);
    if (packages.length === 0) {
      console.log('  Warning: No packages found, skipping');
      return false;
    }

    // Create temporary directory
    const workdir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'convert-nuget-'));
    const csprojPath = path.join(workdir, 'TempLockProject.csproj');

    try {
      // Generate .csproj file
      const csprojContent = generateCsproj(packages, tfm);
      await fs.writeFile(csprojPath, csprojContent, 'utf8');

      // Run dotnet restore
      try {
        execSync(`dotnet restore "${csprojPath}" --use-lock-file --force-evaluate`, {
          cwd: workdir,
          stdio: 'pipe',
        });
      } catch (err) {
        console.error('  Error: dotnet restore failed:');
        const stdout = err.stdout?.toString();
        const stderr = err.stderr?.toString();
        if (stdout) console.error(stdout);
        if (stderr) console.error(stderr);
        return false;
      }

      // Copy lock file
      const lockPath = path.join(workdir, 'packages.lock.json');
      await fs.copyFile(lockPath, lockFilePath);
      console.log(`  ✓ Generated: ${lockFilePath}`);
      return true;
    } finally {
      // Cleanup
      await fs.rm(workdir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    return false;
  }
}

async function main() {
  const { tfm, rootDir } = parseArgs();

  // Resolve root directory to absolute path
  const resolvedRootDir = path.resolve(rootDir);

  // Check if root directory exists
  try {
    const stats = await fs.stat(resolvedRootDir);
    if (!stats.isDirectory()) {
      console.error(`Error: Root directory is not a directory: ${resolvedRootDir}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: Root directory does not exist: ${resolvedRootDir}`);
    process.exit(1);
  }

  // Check for dotnet
  try {
    execSync('dotnet --version', { stdio: 'ignore' });
  } catch (err) {
    console.error('Error: dotnet CLI is required but not installed');
    process.exit(1);
  }

  console.log('=== NuGet packages.config to packages.lock.json Converter ===');
  console.log(`Root directory: ${resolvedRootDir}`);
  console.log(`Target Framework: ${tfm}`);
  console.log('Searching for packages.config files...');
  console.log('');

  // Find all packages.config files
  const packagesConfigFiles = await findPackagesConfigFiles(resolvedRootDir);

  let successCount = 0;
  let failCount = 0;

  for (const packagesConfig of packagesConfigFiles) {
    if (await processPackagesConfig(packagesConfig, tfm)) {
      successCount++;
    } else {
      failCount++;
    }
  }

  if (packagesConfigFiles.length === 0) {
    console.log(`No packages.config files found in: ${resolvedRootDir}`);
  }

  console.log('');
  console.log('Summary:');
  console.log(`  Found: ${packagesConfigFiles.length} packages.config file(s)`);
  console.log(`  Success: ${successCount}`);
  console.log(`  Failed: ${failCount}`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});


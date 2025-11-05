#!/usr/bin/env node
/**
 * convert-nuget: Converts packages.config files to packages.lock.json recursively
 * Supports monorepo structures by processing all packages.config files in a directory tree
 */

const fs = require('fs').promises;
const path = require('path');
const { execFileSync } = require('child_process');
const { XMLParser } = require('fast-xml-parser');

const DEFAULT_TFM = 'net472';

function parseArgs() {
  const args = process.argv.slice(2);
  let tfm = DEFAULT_TFM;
  let rootDir = process.cwd();
  let failOnSkipped = false;

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
      case '--fail-on-skipped':
        failOnSkipped = true;
        break;
      case '-h':
      case '--help':
        console.log(`Usage: convert-nuget.js [--tfm <TFM>] [--root <DIR>] [--fail-on-skipped]

Recursively finds all packages.config files starting from the current directory
(or --root if specified) and generates a packages.lock.json next to each one.

Options:
  --tfm <TFM>            Target framework moniker (default: ${DEFAULT_TFM})
  --root <DIR>           Root directory to search (default: current working directory)
  --fail-on-skipped      Exit with error code if any packages are skipped
  -h, --help             Show this help message`);
        process.exit(0);
      default:
        console.error(`Error: Unknown option: ${args[i]}`);
        process.exit(2);
    }
  }

  return { tfm, rootDir, failOnSkipped };
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
  let targetFramework = null;

  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text'
    });
    const result = parser.parse(xml);
    
    if (result.packages && result.packages.package) {
      const packageList = Array.isArray(result.packages.package) 
        ? result.packages.package 
        : [result.packages.package];
      
      for (const pkg of packageList) {
        if (pkg['@_id'] && pkg['@_version']) {
          packages.push({
            id: pkg['@_id'],
            version: pkg['@_version']
          });
          
          // Extract targetFramework from first package (assuming all packages use the same)
          if (!targetFramework && pkg['@_targetFramework']) {
            targetFramework = pkg['@_targetFramework'];
            // Convert netframework40 -> net40, netframework20 -> net20, etc.
            if (targetFramework.startsWith('netframework')) {
              const version = targetFramework.replace('netframework', '').replace(/\./g, '');
              targetFramework = `net${version}`;
            }
          }
        }
      }
    }
  } catch (err) {
    throw new Error(`Failed to parse packages.config: ${err.message}`);
  }

  return { packages, targetFramework };
}

function generatePackageReferences(packages) {
  return packages
    .map((pkg) => `    <PackageReference Include="${pkg.id}" Version="${pkg.version}" />`)
    .join('\n');
}

function extractIncompatiblePackages(errorOutput) {
  const incompatiblePackages = [];
  // Match NU1202 errors that mention a package
  // Example: "Package recaptcha 1.0.5 is not compatible with net47"
  const nu1202Regex = /Package\s+([^\s]+)\s+([0-9.]+)\s+is\s+not\s+compatible/gi;
  let match;
  while ((match = nu1202Regex.exec(errorOutput)) !== null) {
    incompatiblePackages.push({
      id: match[1],
      version: match[2]
    });
  }
  return incompatiblePackages;
}

function generateCsproj(packages, tfm, hasExplicitTfm) {
  const packageRefs = generatePackageReferences(packages);
  let properties = `    <TargetFramework>${tfm}</TargetFramework>
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>`;
  
  // Add AssetTargetFallback when TFM was explicitly set in packages.config
  // This allows older framework packages to work via framework compatibility
  if (hasExplicitTfm && tfm.startsWith('net4')) {
    properties += `\n    <AssetTargetFallback>$(AssetTargetFallback);net40;net45;net46;net461;net462;net20</AssetTargetFallback>`;
  }
  
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
${properties}
  </PropertyGroup>
  <ItemGroup>
${packageRefs}
  </ItemGroup>
</Project>`;
}

async function findCsprojFile(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const csprojFiles = entries
      .filter(e => e.isFile() && e.name.endsWith('.csproj'))
      .map(e => path.join(dir, e.name));
    
    if (csprojFiles.length === 0) return null;
    if (csprojFiles.length > 1) {
      throw new Error(`Multiple .csproj files found in ${dir}: ${csprojFiles.map(f => path.basename(f)).join(', ')}`);
    }
    return csprojFiles[0];
  } catch (err) {
    if (err.message.includes('Multiple .csproj files')) throw err;
    return null;
  }
}

async function processPackagesConfig(packagesConfigPath, defaultTfm, failOnSkipped = false) {
  const lockFilePath = path.join(
    path.dirname(packagesConfigPath),
    'packages.lock.json'
  );

  console.log(`Processing: ${packagesConfigPath}`);

  try {
    const dir = path.dirname(packagesConfigPath);
    let existingCsproj;
    try {
      existingCsproj = await findCsprojFile(dir);
    } catch (err) {
      if (err.message.includes('Multiple .csproj files')) {
        console.error(`  Error: ${err.message}`);
        return { success: false, skippedPackages: [] };
      }
      throw err;
    }
    
    if (existingCsproj) {
      // Use existing .csproj file
      console.log(`  Using existing .csproj: ${path.basename(existingCsproj)}`);
      try {
        execFileSync('dotnet', ['restore', existingCsproj, '--use-lock-file', '--force-evaluate'], {
          cwd: dir,
          stdio: 'pipe',
        });
        // Copy lock file (check root first, then obj/)
        const lockPath = path.join(dir, 'packages.lock.json');
        const objLockPath = path.join(dir, 'obj', 'packages.lock.json');
        
        try {
          await fs.copyFile(lockPath, lockFilePath);
          console.log(`  ✓ Lock file already exists: ${lockFilePath}`);
          return { success: true, skippedPackages: [] };
        } catch {
          try {
            await fs.copyFile(objLockPath, lockFilePath);
            console.log(`  ✓ Generated: ${lockFilePath}`);
            return { success: true, skippedPackages: [] };
          } catch {
            console.log(`  Warning: Lock file not found after restore`);
            return { success: false, skippedPackages: [] };
          }
        }
      } catch (err) {
        console.error('  Error: dotnet restore failed:');
        const stdout = err.stdout?.toString();
        const stderr = err.stderr?.toString();
        if (stdout) console.error(stdout);
        if (stderr) console.error(stderr);
        return { success: false, skippedPackages: [] };
      }
    }

    // Fall back to generating a temporary .csproj from packages.config
    // Parse packages.config
    const { packages, targetFramework } = await parsePackagesConfig(packagesConfigPath);
    if (packages.length === 0) {
      console.log('  Warning: No packages found, skipping');
      return { success: false, skippedPackages: [] };
    }

    // Use targetFramework from packages.config if available, otherwise use default
    const tfm = targetFramework || defaultTfm;
    if (targetFramework && targetFramework !== defaultTfm) {
      console.log(`  Using targetFramework from packages.config: ${tfm}`);
    }

    // Create temporary directory
    const workdir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'convert-nuget-'));
    const csprojPath = path.join(workdir, 'TempLockProject.csproj');

    try {
      let compatiblePackages = [...packages];
      let skippedPackages = [];
      const maxRetries = 20; // Prevent infinite loops
      let retryCount = 0;
      let restoreSuccess = false;
      let lastError = null;
      
      // Normalize version for comparison: remove trailing .0 segments
      const normalizeVersion = v => v.split('.').filter((p, i, arr) => i < arr.length - 1 || p !== '0').join('.');
      
      while (retryCount < maxRetries && compatiblePackages.length > 0) {
        try {
          await fs.writeFile(csprojPath, generateCsproj(compatiblePackages, tfm, targetFramework !== null), 'utf8');
          execFileSync('dotnet', ['restore', csprojPath, '--use-lock-file', '--force-evaluate'], {
            cwd: workdir,
            stdio: 'pipe',
          });
          restoreSuccess = true;
          if (skippedPackages.length > 0) {
            const skippedList = skippedPackages.map(p => `${p.id}@${p.version}`).join(', ');
            console.log(`  Warning: Skipped ${skippedPackages.length} incompatible package(s): ${skippedList}`);
            if (failOnSkipped) {
              throw new Error(`Packages were skipped: ${skippedList}`);
            }
          }
          break;
        } catch (err) {
          lastError = err;
          const stdout = err.stdout?.toString() || '';
          const stderr = err.stderr?.toString() || '';
          const errorOutput = stdout + stderr;
          
          // If no error output, the command might have failed for other reasons
          if (!errorOutput && err.message) {
            console.error(`  Error: ${err.message}`);
          }
          
          if (errorOutput.includes('NU1202')) {
            const incompatible = extractIncompatiblePackages(errorOutput);
            if (incompatible.length > 0) {
              const beforeCount = compatiblePackages.length;
              compatiblePackages = compatiblePackages.filter(pkg => 
                !incompatible.some(incomp => 
                  incomp.id.toLowerCase() === pkg.id.toLowerCase() && 
                  normalizeVersion(incomp.version) === normalizeVersion(pkg.version)
                )
              );
              if (compatiblePackages.length < beforeCount) {
                skippedPackages.push(...incompatible);
                retryCount++;
                continue;
              }
            }
          }
          break;
        }
      }

      if (!restoreSuccess) {
        console.error('  Error: dotnet restore failed:');
        if (lastError.stdout) console.error(lastError.stdout.toString());
        if (lastError.stderr) console.error(lastError.stderr.toString());
        return { success: false, skippedPackages };
      }

      // Copy lock file
      await fs.copyFile(path.join(workdir, 'packages.lock.json'), lockFilePath);
      console.log(`  ✓ Generated: ${lockFilePath}`);
      return { success: true, skippedPackages };
    } finally {
      // Cleanup
      await fs.rm(workdir, { recursive: true, force: true });
    }
  } catch (err) {
    if (failOnSkipped && err.message.includes('Packages were skipped')) {
      console.error(`  Error: ${err.message}`);
      return { success: false, skippedPackages: [] };
    }
    console.error(`  Error: ${err.message}`);
    return { success: false, skippedPackages: [] };
  }
}

async function main() {
  const { tfm, rootDir, failOnSkipped } = parseArgs();

  // Resolve root directory to absolute path and validate
  const resolvedRootDir = path.resolve(rootDir);
  
  // Validate path traversal: ensure resolved path doesn't contain suspicious patterns
  if (resolvedRootDir.includes('..') || (resolvedRootDir.includes('~') && !resolvedRootDir.startsWith(process.env.HOME || ''))) {
    console.error(`Error: Invalid root directory path: ${resolvedRootDir}`);
    process.exit(1);
  }

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

  // Check for dotnet - try common paths, then fall back to PATH
  const commonPaths = [
    process.env.DOTNET_ROOT && path.join(process.env.DOTNET_ROOT, 'dotnet'),
    '/usr/bin/dotnet',
    '/usr/local/bin/dotnet',
    '/usr/share/dotnet/dotnet'
  ].filter(Boolean);
  
  let dotnetFound = false;
  for (const testPath of commonPaths) {
    try {
      await fs.access(testPath);
      execFileSync(testPath, ['--version'], { stdio: 'ignore' });
      dotnetFound = true;
      break;
    } catch {
      continue;
    }
  }
  
  if (!dotnetFound) {
    try {
      execFileSync('dotnet', ['--version'], { stdio: 'ignore' });
    } catch {
      console.error('Error: dotnet CLI is required but not installed');
      process.exit(1);
    }
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
  let totalSkippedPackages = [];

  for (const packagesConfig of packagesConfigFiles) {
    const result = await processPackagesConfig(packagesConfig, tfm, failOnSkipped);
    if (result.success) {
      successCount++;
    } else {
      failCount++;
    }
    if (result.skippedPackages?.length > 0) {
      totalSkippedPackages.push(...result.skippedPackages);
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
  if (totalSkippedPackages.length > 0) {
    const uniqueSkipped = Array.from(new Map(totalSkippedPackages.map(p => [`${p.id}@${p.version}`, p])).values());
    console.log(`  Skipped packages: ${uniqueSkipped.length} unique package(s)`);
    if (failOnSkipped) {
      console.log(`  Skipped: ${uniqueSkipped.map(p => `${p.id}@${p.version}`).join(', ')}`);
    }
  }

  if (failCount > 0) {
    process.exit(1);
  }
  
  if (failOnSkipped && totalSkippedPackages.length > 0) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});



import fs from 'node:fs';
import path from 'node:path';

export function inspectDataTree(dataPath) {
  const files = [];
  const links = [];
  const visit = (directory, relative = 'Data') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.toLocaleLowerCase('en-US').localeCompare(b.name.toLocaleLowerCase('en-US')));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const manifestPath = `${relative}/${entry.name}`.replace(/\\/g, '/');
      if (entry.isSymbolicLink()) { links.push(manifestPath); continue; }
      if (entry.isDirectory()) { visit(absolute, manifestPath); continue; }
      if (entry.isFile()) files.push(manifestPath);
    }
  };
  visit(dataPath);
  return { files, links };
}

export function findUnexpectedDataFiles(files, knownPaths, ignoredPaths = []) {
  const canonicalKey = value => String(value).toLocaleLowerCase('en-US');
  const known = new Set(knownPaths.map(canonicalKey));
  const ignored = new Set(ignoredPaths.map(canonicalKey));
  return files.filter(file => {
    const key = canonicalKey(file);
    return !known.has(key) && !ignored.has(key);
  });
}

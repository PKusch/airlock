/**
 * Print a draft manifest for the tools in a tools/list dump.
 *
 *   npm run draft -- corpus/real-mcp-tools.json
 *
 * Accepts either a bare list of tool definitions, `{ "tools": [...] }`, or the
 * file `npm run introspect` writes (a list of `{ id, tools }` servers).
 */
import { readFileSync } from 'node:fs';
import { draftManifest } from '../src/mcp/draft.ts';

const usage = 'usage: npm run draft -- <tools.json>';
const file = process.argv[2];
if (file === '--help' || file === '-h') {
  // asked for, so on stdout and not an error (it used to be read as a file name)
  console.log(usage);
  process.exit(0);
}
if (!file) {
  console.error(usage);
  process.exit(2);
}

let data: any;
try {
  data = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); // a BOM from Notepad is not content
} catch (e) {
  console.error(`airlock: cannot read '${file}': ${(e as Error).message}`);
  process.exit(2);
}
const tools = Array.isArray(data)
  ? data.flatMap((item) => (Array.isArray(item?.tools) ? item.tools : [item]))
  : data.tools;
if (!Array.isArray(tools)) {
  console.error(`${file}: no tools found`);
  process.exit(2);
}

process.stdout.write(draftManifest(tools));
console.error(`airlock: ${tools.length} tool(s). Replace every "TODO" after reading the tool, then pin the file with --manifest-sha.`);

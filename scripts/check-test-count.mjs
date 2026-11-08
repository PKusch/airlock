// Fails if a test count quoted in README.md differs from what `npm test` ran.
// Counts were fixed by hand three times and drifted each time (159, 169, 175).
//
//   npm test 2>&1 | tee test.log && node scripts/check-test-count.mjs test.log
import { readFileSync } from 'node:fs';

const log = readFileSync(process.argv[2] ?? '', 'utf8');
// the spec reporter prints "ℹ tests N", the tap reporter "# tests N"
const m = log.match(/^(?:ℹ|#) tests (\d+)$/m);
if (!m) {
  console.error('no "tests N" summary line in the test output');
  process.exit(1);
}
const ran = Number(m[1]);
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const wrong = [...readme.matchAll(/(?:\*\*)?(\d+)(?:\*\*)? tests\b/g)]
  .map((x) => Number(x[1])).filter((n) => n !== ran);
if (wrong.length) {
  console.error(`README.md quotes ${wrong.join(', ')} tests; npm test ran ${ran}`);
  process.exit(1);
}
console.log(`README test counts match: ${ran}`);

// Spike (d) laptop baseline: the same carrom bench the app runs on Hermes, run under Node.
// Node 24 strips the TypeScript types of the imported module natively.
//   ../../scripts/isolated.sh node scripts/bench-node.mjs [shots]
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { runCarromBench } from '../src/carrom/carromBench.ts';

const shots = Number(process.argv[2] ?? 200);
const now = () => performance.now();
const configs = [
  { allBullets: true, mu: 0.18 }, // the configuration the app reports
  { allBullets: false, mu: 0.18 },
  { allBullets: true, mu: 0.1 }, // slicker board: longer shots
];
const out = {
  node: process.version,
  cpu: os.cpus()[0]?.model,
  results: configs.map((c) => runCarromBench({ shots, warmupShots: 20, seed: 1, now, ...c })),
};
console.log(JSON.stringify(out, null, 2));

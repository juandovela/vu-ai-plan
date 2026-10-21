/**
 * Writes the JSON Schemas of the contract to /contract.
 * Run with `npm run contract` after changing src/contract.ts and commit them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTRACT_VERSION } from '../src/contract';
import { contractJsonSchemas } from '../src/jsonSchema';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'contract');
mkdirSync(out, { recursive: true });

const schemas = contractJsonSchemas();

Object.keys(schemas).forEach(name => {
  writeFileSync(join(out, `${name}.schema.json`), JSON.stringify(schemas[name], null, 2) + '\n');
});

console.log(`contract v${CONTRACT_VERSION}: ${Object.keys(schemas).length} schemas written to ${out}`);

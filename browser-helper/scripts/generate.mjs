import { mkdir, writeFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { snapshotSchema } from '../src/schema.mjs';

const ajv = new Ajv({ allErrors: true, code: { source: true, lines: true }, strict: true });
addFormats(ajv, { mode: 'full', formats: ['date', 'date-time'] });
const validate = ajv.compile(snapshotSchema);
await mkdir(new URL('../generated/', import.meta.url), { recursive: true });
await writeFile(new URL('../generated/validate.cjs', import.meta.url), standaloneCode(ajv, validate));
await writeFile(new URL('../snapshot.schema.json', import.meta.url), JSON.stringify(snapshotSchema, null, 2) + '\n');
console.log('Generated snapshot schema and CSP-safe standalone validator.');

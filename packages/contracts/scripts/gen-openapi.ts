import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOpenApiDocument } from '../src/openapi.js';

const doc = buildOpenApiDocument();
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'openapi.json');
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);

const schemas = Object.keys(doc.components?.schemas ?? {}).length;
const paths = Object.keys(doc.paths ?? {}).length;
// eslint-disable-next-line no-console
console.log(`wrote ${out} — ${schemas} component schemas, ${paths} paths`);

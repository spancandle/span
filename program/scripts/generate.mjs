import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFromRoot } from 'codama';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(`${root}client/idl`, { recursive: true });
copyFileSync(`${root}target/idl/span.json`, `${root}client/idl/span.json`);
const idl = JSON.parse(readFileSync(`${root}client/idl/span.json`, 'utf8'));
const codama = createFromRoot(rootNodeFromAnchor(idl));

await codama.accept(renderVisitor(`${root}client`, {
  syncPackageJson: false, kitImportStrategy: 'rootOnly', importExtension: 'js',
  internalNodes: [], formatCode: true,
}));

console.log(JSON.stringify({ program: idl.address, instructions: idl.instructions.map(i => i.name) }));

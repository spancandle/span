import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFromRoot } from 'codama';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(`${root}client/idl`, { recursive: true });
copyFileSync(`${root}target/idl/span.json`, `${root}client/idl/span.json`);
const idl = JSON.parse(readFileSync(`${root}client/idl/span.json`, 'utf8'));
// These canonical read-only PDAs are required remaining accounts, after event CPI accounts.
// Keep the on-chain IDL's declared account lists unchanged.
const clientIdl = structuredClone(idl);
const band = clientIdl.instructions.find(i => i.name === 'open_ticket').accounts.find(a => a.name === 'band');
for (const name of ['settle', 'mark', 'buy_running', 'buy_resale', 'accept_bid', 'fill_request_held'])
  clientIdl.instructions.find(i => i.name === name).accounts.push({ ...structuredClone(band), writable: false });
const codama = createFromRoot(rootNodeFromAnchor(clientIdl));

await codama.accept(renderVisitor(`${root}client`, {
  syncPackageJson: false, kitImportStrategy: 'rootOnly', importExtension: 'js',
  internalNodes: [], formatCode: true,
}));

console.log(JSON.stringify({ program: idl.address, instructions: idl.instructions.map(i => i.name) }));

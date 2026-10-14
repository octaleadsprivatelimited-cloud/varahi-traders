import { fileURLToPath } from "node:url";
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../.output/public/', import.meta.url));
const names = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'INTEGRATION_ENCRYPTION_KEY', 'DATABASE_URL', 'DATABASE_PASSWORD', 'CASHFREE_CLIENT_SECRET', 'RESEND_API_KEY', 'FIREBASE_PRIVATE_KEY'];
const secrets = names.flatMap(name => process.env[name]?.length >= 8 ? [{ name, value: process.env[name] }] : []);
let checked = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await walk(path); continue; }
    const content = await readFile(path); checked++;
    for (const secret of secrets) if (content.includes(Buffer.from(secret.value)))
      throw new Error(`Server secret ${secret.name} was found in a public asset: ${path.slice(root.length)}`);
    if (/^(\.env(?:\..*)?|\.git|credentials\.json|service-account\.json)$/i.test(entry.name))
      throw new Error(`Private configuration found in public assets: ${path.slice(root.length)}`);
  }
}
await walk(root);
console.log(`Public asset scan passed: ${checked} files checked; configured server secrets and private configuration files are absent.`);

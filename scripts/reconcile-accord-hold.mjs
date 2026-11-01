// Run on the owning gateway host after a verified, drained deployment fence.
import fs from 'node:fs';
import path from 'node:path';
import { reconcileLegacyHold } from '../src/accord-migration.mjs';
import { gatewayRequest } from '../src/gateway-client.mjs';
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (!args.includes('--config') || !args.includes('--plan')) throw Error('--config FILE --plan FILE [--apply --yes]');
const sourcePath = path.resolve(value('--config'));
const config = { ...JSON.parse(fs.readFileSync(sourcePath, 'utf8')), sourcePath };
const plan = JSON.parse(fs.readFileSync(value('--plan'), 'utf8'));
const apply = args.includes('--apply');
if (apply && !args.includes('--yes')) throw Error('--apply requires --yes');
const fence = await gatewayRequest(config, '/gateway/deployment-fence/status', { throwOnError: true });
console.log(JSON.stringify(await reconcileLegacyHold({ config, plan, fence, apply })));

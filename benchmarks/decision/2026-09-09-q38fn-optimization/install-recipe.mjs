// Scoped package metadata update; preserves every unrelated recipe entry.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = '/home/enntitysparkadmin/.local/lib/node_modules/lloom/recipes';
const entry = JSON.parse(await fs.readFile('/tmp/q38-recipe-index-entry.json', 'utf8'));
assert.equal(entry.id, 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-vllm');
assert.equal(entry.currentVersion, 7);
const indexPath = root + '/index.json',
  index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
const i = index.recipes.findIndex((x) => x.id === entry.id);
assert(i >= 0);
assert.equal(index.recipes[i].currentVersion, 6);
const recipe = JSON.parse(await fs.readFile('/tmp/q38-recipe-v7.json', 'utf8'));
assert.equal(recipe.id, entry.id);
assert.equal(recipe.version, 7);
const current = root + '/' + entry.path;
const old = JSON.parse(await fs.readFile(current, 'utf8'));
assert.equal(old.version, 6);
await fs.copyFile(current, root + '/archive/' + entry.id + '/v6.json');
await fs.copyFile('/tmp/q38-recipe-v7.json', current);
await fs.copyFile(indexPath, indexPath + '.before-q38-v7-' + Date.now());
index.recipes[i] = entry;
await fs.writeFile(indexPath + '.q38.tmp', JSON.stringify(index, null, 2) + '\n');
await fs.rename(indexPath + '.q38.tmp', indexPath);
console.log(
  JSON.stringify({ installedRecipe: entry.id, version: 7, previousArchived: 6, unrelatedEntriesPreserved: true })
);

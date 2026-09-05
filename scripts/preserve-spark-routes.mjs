import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function preserveSparkRoutes(before, after) {
  const result = structuredClone(after);
  for (const field of ['aliases', 'defaults', 'routing', 'clientCatalog']) {
    if (Object.hasOwn(before, field)) result[field] = structuredClone(before[field]);
    else delete result[field];
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [beforePath, target] = process.argv.slice(2);
  const before = JSON.parse(await fs.readFile(beforePath, 'utf8'));
  const after = JSON.parse(await fs.readFile(target, 'utf8'));
  const temporary = `${target}.preserve-routes-${process.pid}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(preserveSparkRoutes(before, after), null, 2)}\n`, {
      mode: (await fs.stat(target)).mode
    });
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

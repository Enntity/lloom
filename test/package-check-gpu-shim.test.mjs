import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createCollectors } from '../vendor/accord/src/telemetry-collectors.mjs';
import { writeFakeNvidiaSmi } from '../scripts/fake-nvidia-smi.mjs';

const execFileAsync = promisify(execFile);

test('the package check fakes a GB10 that the machine profile collectors detect', async (t) => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-fake-nvidia-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  const smi = await writeFakeNvidiaSmi(bin);
  const run = (command, args) => execFileAsync(command === 'nvidia-smi' ? smi : command, args);
  const collectors = createCollectors({ platform: 'linux', arch: 'x64', run });

  const metadata = await collectors.metadata();
  const gpus = metadata.devices.filter((device) => device.vendor === 'nvidia');
  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].name, 'NVIDIA GB10');
  assert.equal(gpus[0].memoryTotalMb, 131072);
  assert.equal(gpus[0].computeCapability, '12.1');

  const { stdout } = await execFileAsync(smi, [
    '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,pstate,clocks.current.sm,clocks.current.memory',
    '--format=csv,noheader,nounits'
  ]);
  assert.equal(stdout.trim().split(',').length, 10, 'one value per requested telemetry field');
});

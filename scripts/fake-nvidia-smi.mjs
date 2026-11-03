// A stand-in nvidia-smi that reports one GB10, for package checks on hosts without one.
// It answers each field named in --query-gpu, so callers can ask for any layout.
import fs from 'node:fs/promises';
import path from 'node:path';

const GB10 = {
  index: '0',
  uuid: 'GPU-00000000-0000-0000-0000-000000000000',
  name: 'NVIDIA GB10',
  'memory.total': '131072',
  'memory.used': '0',
  compute_cap: '12.1',
  driver_version: '580.95.05',
  'pci.bus_id': '00000000:01:00.0',
  'utilization.gpu': '0',
  'temperature.gpu': '40',
  'power.draw': '10',
  pstate: 'P8',
  'clocks.current.sm': '0',
  'clocks.current.memory': '0'
};

export async function writeFakeNvidiaSmi(dir) {
  const file = path.join(dir, 'nvidia-smi');
  const cases = Object.entries(GB10)
    .map(([field, value]) => `    ${field}) value='${value}' ;;`)
    .join('\n');
  const script = `#!/bin/sh
fields=
for arg in "$@"; do
  case "$arg" in --query-gpu=*) fields=\${arg#--query-gpu=} ;; esac
done
[ -n "$fields" ] || fields=index,name,memory.total,compute_cap
line=
IFS=,
for field in $fields; do
  case "$field" in
${cases}
    *) value='[N/A]' ;;
  esac
  line=\${line:+$line, }$value
done
printf '%s\\n' "$line"
`;
  await fs.writeFile(file, script, { mode: 0o755 });
  return file;
}

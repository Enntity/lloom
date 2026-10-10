import path from 'node:path';
import { NodeReleaseAgent } from './node-release-agent.mjs';
import { createNodeGatewayAdapter } from './node-gateway-adapter.mjs';

const PHASES = new Set([
  'preflight',
  'stage',
  'prepare',
  'swap',
  'restart',
  'verify',
  'canary',
  'promote',
  'release',
  'reprepare',
  'rollback',
  'discard-stage'
]);

function safePhase(value) {
  if (!PHASES.has(value)) throw Object.assign(new Error('unsupported node-agent phase'), { code: 'invalid_phase' });
  return value;
}

function publicError(error, phase) {
  return {
    ok: false,
    phase: PHASES.has(phase) ? phase : 'unknown',
    code: /^[a-z][a-z0-9_:-]{0,63}$/.test(error?.code ?? '') ? error.code : 'node_agent_failure',
    message: 'node operation failed'
  };
}

export async function handleNodeAgentRequest({ phase, input, agent, output = process.stdout } = {}) {
  const selected = safePhase(phase);
  const context = input && typeof input === 'object' ? input : null;
  if (!context || typeof context.nodeId !== 'string')
    throw Object.assign(new Error('node-agent request is invalid'), { code: 'invalid_request' });
  const method = selected === 'discard-stage' ? 'discardStage' : selected;
  const receipt = await agent[method](context.nodeId, context);
  // The SSH transport consumes the public receipt directly. Keep the wire
  // shape identical to the coordinator adapter contract.
  const result = receipt;
  output.write(`${JSON.stringify(result)}\n`);
  return result;
}

export async function runNodeAgentCli({
  argv = process.argv.slice(2),
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  agent = null
} = {}) {
  try {
    const phase = safePhase(argv[0]);
    if (!argv.includes('--json'))
      throw Object.assign(new Error('node-agent requires --json'), { code: 'json_required' });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of input) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 512 * 1024)
        throw Object.assign(new Error('node-agent request is too large'), { code: 'request_too_large' });
      chunks.push(chunk);
    }
    let request;
    try {
      request = JSON.parse(
        Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))).toString('utf8')
      );
    } catch {
      throw Object.assign(new Error('node-agent request is invalid'), { code: 'invalid_request' });
    }
    const selectedAgent =
      agent ??
      new NodeReleaseAgent({
        nodeId: env.LLOOM_NODE_ID,
        root: env.LLOOM_NODE_RELEASE_ROOT ?? env.LLOOM_NODE_ROOT,
        configPath: env.LLOOM_NODE_CONFIG_PATH,
        serviceUnit: env.LLOOM_NODE_SERVICE_UNIT ?? 'lloom.service',
        gateway: createNodeGatewayAdapter({
          baseUrl: env.LLOOM_GATEWAY_URL ?? 'http://127.0.0.1:8100',
          adminApiKey: env.LLOOM_ADMIN_API_KEY
        }),
        run: async (command, args, options) => {
          const { default: childProcess } = await import('node:child_process');
          return new Promise((resolve, reject) => {
            const child = childProcess.spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            let timer = null;
            child.stdout.on('data', (chunk) => (stdout += chunk));
            child.stderr.on('data', (chunk) => (stderr += chunk));
            child.on('error', (error) => {
              if (timer) clearTimeout(timer);
              reject(error);
            });
            child.on('close', (code) => {
              if (timer) clearTimeout(timer);
              resolve({ code, stdout, stderr });
            });
            if (options?.timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
          });
        }
      });
    return await handleNodeAgentRequest({ phase, input: request, agent: selectedAgent, output });
  } catch (error) {
    const result = publicError(error, PHASES.has(argv[0]) ? argv[0] : 'unknown');
    errorOutput.write(`${JSON.stringify(result)}\n`);
    return result;
  }
}

export const nodeAgentPaths = ({ root }) => ({
  root: path.resolve(root),
  configPath: path.resolve(root, 'config.json')
});

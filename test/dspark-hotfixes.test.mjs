import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const packRoot = path.join(repoRoot, 'backends', 'dspark-vllm', 'packs', 'miaai-dsv4flash-d1b76251-defaults');
const hotfixRoot = path.join(packRoot, 'patches');
const packManifestPath = path.join(packRoot, 'manifest.json');
const packRunner = path.join(repoRoot, 'backends', 'dspark-vllm', 'apply-patch-pack.py');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'lloom-dspark-hotfixes-'));

function fixturePath(root, relativePath) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

function writeFixture(root, relativePath, content) {
  const target = fixturePath(root, relativePath);
  writeFileSync(target, content);
  return target;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...options.env }
  });
}

try {
  const recipe = JSON.parse(
    readFileSync(path.join(repoRoot, 'recipes', 'linux-nvidia-dgx-spark-2x-deepseek-v4-flash-mia-vllm.json'), 'utf8')
  );
  assert.equal(recipe.version, 13);
  assert.match(recipe.provenance.source, /d1b76251535daef578d8751b04b39c29ad7ecdf9/);
  assert.equal(recipe.models[0].settings.contextWindow, 262144);
  assert.equal(recipe.models[0].settings.maxOutputTokens, 65536);
  assert.equal(recipe.models[0].settings.maxActiveRequests, 6);
  const archivedRecipe = JSON.parse(
    readFileSync(
      path.join(repoRoot, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-deepseek-v4-flash-mia-vllm', 'v4.json'),
      'utf8'
    )
  );
  assert.equal(archivedRecipe.version, 4);
  const archivedV5Recipe = JSON.parse(
    readFileSync(
      path.join(repoRoot, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-deepseek-v4-flash-mia-vllm', 'v5.json'),
      'utf8'
    )
  );
  assert.equal(archivedV5Recipe.version, 5);
  const archivedV6Recipe = JSON.parse(
    readFileSync(
      path.join(repoRoot, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-deepseek-v4-flash-mia-vllm', 'v6.json'),
      'utf8'
    )
  );
  assert.equal(archivedV6Recipe.version, 6);
  const archivedV7Recipe = JSON.parse(
    readFileSync(
      path.join(repoRoot, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-deepseek-v4-flash-mia-vllm', 'v7.json'),
      'utf8'
    )
  );
  assert.equal(archivedV7Recipe.version, 7);
  const archivedV8Recipe = JSON.parse(
    readFileSync(
      path.join(repoRoot, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-deepseek-v4-flash-mia-vllm', 'v8.json'),
      'utf8'
    )
  );
  assert.equal(archivedV8Recipe.version, 8);
  const archivedV9Recipe = JSON.parse(
    readFileSync(
      path.join(repoRoot, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-deepseek-v4-flash-mia-vllm', 'v9.json'),
      'utf8'
    )
  );
  assert.equal(archivedV9Recipe.version, 9);
  const archivedV10Recipe = JSON.parse(
    readFileSync(
      path.join(repoRoot, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-deepseek-v4-flash-mia-vllm', 'v10.json'),
      'utf8'
    )
  );
  assert.equal(archivedV10Recipe.version, 10);
  const archivedV11Recipe = JSON.parse(
    readFileSync(
      path.join(repoRoot, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-deepseek-v4-flash-mia-vllm', 'v11.json'),
      'utf8'
    )
  );
  assert.equal(archivedV11Recipe.version, 11);
  const archivedV12Recipe = JSON.parse(
    readFileSync(
      path.join(repoRoot, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-deepseek-v4-flash-mia-vllm', 'v12.json'),
      'utf8'
    )
  );
  assert.equal(archivedV12Recipe.version, 12);
  const recipeIndex = JSON.parse(readFileSync(path.join(repoRoot, 'recipes', 'index.json'), 'utf8'));
  const indexEntry = recipeIndex.recipes.find((candidate) => candidate.id === recipe.id);
  assert.equal(indexEntry.currentVersion, 13);
  assert.deepEqual(
    indexEntry.versions.map(({ version, status }) => ({ version, status })),
    [
      { version: 4, status: 'archived' },
      { version: 5, status: 'archived' },
      { version: 6, status: 'archived' },
      { version: 7, status: 'archived' },
      { version: 8, status: 'archived' },
      { version: 9, status: 'archived' },
      { version: 10, status: 'archived' },
      { version: 11, status: 'archived' },
      { version: 12, status: 'archived' },
      { version: 13, status: 'current' }
    ]
  );

  const expectedHotfixes = [
    'hotfix-encoding-dsv4-issue21.py',
    'hotfix-nvfp4-ds-mla-issue22.sh',
    'hotfix-dsv4-grammar-advance.sh',
    'hotfix-vllm-xgrammar-termination-52805.sh',
    'hotfix-dsv4-mtp-padding-lengths-51538.py',
    'hotfix-dsv4-suppress-stops-in-reasoning.py',
    'hotfix-dsv4-issue55-tool-truncation.py',
    'hotfix-gb10-spin-wait.sh',
    'hotfix-vllm-empty-encoder-output.py',
    'hotfix-dsv4-issue27-partial-prefill-concurrency.py',
    'hotfix-dsv4-issue26-hybrid-swa-min.py',
    'hotfix-dsv4-issue43-decode-fairness-and-diag.py',
    'hotfix-dsv4-skip-topk-49486.sh',
    'hotfix-dsv4-dense-prefill-indexer-48407.sh',
    'hotfix-dsv4-mtp-buffer-50312.sh',
    'hotfix-dsv4-skip-empty-c128-48957.sh',
    'hotfix-dsv4-flashmla-workspace-50298.sh'
  ];
  const manifest = JSON.parse(readFileSync(packManifestPath, 'utf8'));
  assert.equal(manifest.upstream.commit, 'd1b76251535daef578d8751b04b39c29ad7ecdf9');
  assert.equal(
    manifest.compatibility.runtimeImage,
    recipe.models[0].settings.placement.members[0].runtimeSettings.bootstrap.image
  );
  assert.deepEqual(
    manifest.patches.filter(({ enabled }) => enabled).map(({ file }) => path.basename(file)),
    expectedHotfixes
  );
  assert.equal(manifest.patches.length, 23);
  const members = recipe.models[0].settings.placement.members;
  assert.equal(members.length, 2);
  for (const member of members) {
    const args = member.runtimeSettings.bootstrap.createArgs;
    const env = new Map();
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] !== '-e') continue;
      const [key, ...value] = args[index + 1].split('=');
      env.set(key, value.join('='));
    }
    assert.equal(env.get('HF_HUB_OFFLINE'), '1');
    assert.equal(env.get('TRANSFORMERS_OFFLINE'), '1');
    assert.equal(env.get('DEFAULT_THINKING'), 'low');
    assert.equal(env.has('DEFAULT_THINKING_TOKEN_BUDGET'), false);
    assert.equal(env.has('DEFAULT_MAX_TOKENS'), false);
    assert.equal(env.get('MAX_MODEL_LEN'), '262144');
    assert.equal(env.get('GPU_MEMORY_UTILIZATION'), '0.73');
    assert.equal(env.get('DSPARK_MAX_INFLIGHT_PREFILLS'), '2');
    assert.equal(env.get('LONG_PREFILL_TOKEN_THRESHOLD'), '1024');
    assert.equal(env.get('VLLM_EXECUTE_MODEL_TIMEOUT_SECONDS'), '1800');
    assert.equal(env.get('TILELANG_CACHE_DIR'), '/cache/huggingface/tilelang-cache');
    assert.equal(env.get('TRITON_CACHE_DIR'), '/cache/huggingface/triton-cache');
    assert.equal(env.get('DSPARK_RUNTIME_IMAGE'), member.runtimeSettings.bootstrap.image);
    assert.match(member.runtimeSettings.bootstrap.image, /@sha256:a8394849/);
    assert(
      args.includes(
        'type=bind,src=${lloomRoot}/backends/dspark-vllm/apply-patch-pack.py,dst=/opt/lloom/apply-patch-pack.py,readonly'
      )
    );
    assert(
      args.includes(
        'type=bind,src=${lloomRoot}/backends/dspark-vllm/packs/miaai-dsv4flash-d1b76251-defaults,dst=/opt/lloom/patch-pack,readonly'
      )
    );
    assert.equal(
      args.some((value) => value.includes('/opt/lloom/hotfixes/')),
      false
    );
  }

  const entrypoint = readFileSync(path.join(repoRoot, 'backends', 'dspark-vllm', 'entrypoint.sh'), 'utf8');
  assert.match(entrypoint, /apply-patch-pack\.py/);
  assert.match(entrypoint, /--runtime-image/);
  assert.match(entrypoint, /--long-prefill-token-threshold/);
  assert.doesNotMatch(entrypoint, /\/opt\/lloom\/hotfixes/);
  run('python3', [
    packRunner,
    '--manifest',
    packManifestPath,
    '--runtime-image',
    manifest.compatibility.runtimeImage,
    '--model',
    manifest.compatibility.model,
    '--model-revision',
    manifest.compatibility.modelRevision,
    '--check-only'
  ]);

  const issue21Root = path.join(tempRoot, 'issue21');
  const issue21Target = writeFixture(
    issue21Root,
    'deepseek_v4_encoding.py',
    `import json

dsml_token = "DSML"

def to_json(value):
    return json.dumps(value, sort_keys=True)

def encode_arguments_to_dsml(tool_call):
    p_dsml_template = '<{dsml_token}parameter name="{key}" string="{is_str}">{value}</{dsml_token}parameter>'
    P_dsml_strs = []

    try:
        arguments = json.loads(tool_call["arguments"])
    except Exception as err:
        arguments = {"arguments": tool_call["arguments"]}

    for k, v in arguments.items():
        p_dsml_str = p_dsml_template.format(
            dsml_token=dsml_token,
            key=k,
            is_str="true" if isinstance(v, str) else "false",
            value=v if isinstance(v, str) else to_json(v),
        )
        P_dsml_strs.append(p_dsml_str)

    return "\\n".join(P_dsml_strs)
`
  );
  const issue21Script = path.join(hotfixRoot, 'hotfix-encoding-dsv4-issue21.py');
  assert.match(run('python3', [issue21Script, issue21Target]), /patch applied/);
  const issue21Probe = run('python3', [
    '-c',
    `import importlib.util, json
spec = importlib.util.spec_from_file_location("encoder", ${JSON.stringify(issue21Target)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
value = {"city": "Paris"}
print(json.dumps([module.encode_arguments_to_dsml({"arguments": json.dumps(value)}), module.encode_arguments_to_dsml({"arguments": value})]))`
  ]);
  const [stringArguments, dictArguments] = JSON.parse(issue21Probe);
  assert.equal(dictArguments, stringArguments);
  assert.match(dictArguments, /name="city"/);
  assert.doesNotMatch(dictArguments, /name="arguments"/);
  assert.match(run('python3', [issue21Script, issue21Target]), /already present/);

  const issue22Root = path.join(tempRoot, 'issue22');
  const issue22Target = writeFixture(
    issue22Root,
    'v1/attention/backends/mla/flashmla_sparse.py',
    '        use_fp8_cache = self.kv_cache_dtype == "fp8_ds_mla"\n'
  );
  const issue22Script = path.join(hotfixRoot, 'hotfix-nvfp4-ds-mla-issue22.sh');
  assert.match(run('bash', [issue22Script], { env: { VLLM_ROOT: issue22Root } }), /applied successfully/);
  assert.match(readFileSync(issue22Target, 'utf8'), /in \("fp8_ds_mla", "nvfp4_ds_mla"\)/);
  assert.match(run('bash', [issue22Script], { env: { VLLM_ROOT: issue22Root } }), /already applied/);

  const issue24Root = path.join(tempRoot, 'issue24');
  const issue24Structured = writeFixture(
    issue24Root,
    'v1/structured_output/__init__.py',
    `    def should_advance(self, request: "Request") -> bool:
        # Check if reasoning ends in *this* step
        delta_from = request.num_computed_tokens - request.num_output_placeholders
        all_token_ids = request.all_token_ids
        start = (
            delta_from if delta_from >= 0 else max(len(all_token_ids) + delta_from, 0)
        )
        if reasoner.is_reasoning_end_streaming(
            all_token_ids, itertools.islice(all_token_ids, start, None)
        ):
            structured_req.reasoning_ended = True

            # Reasoning just ended this step. Defer FSM advance until the next
            # pass (see reasoning_ended check above) for JSON/regex/choice/grammar:
            # advancing on the closing boundary token can accept tokens that still
            # belong to the reasoning stream. Structural tags are the only safe
            # same-step exception: they model phased output (e.g. thinking tag ->
            # answer tag), and speculative decoding must run grammar.validate_tokens
            # on draft tokens produced immediately after that transition.
            if (
                self.vllm_config.speculative_config is not None
                and structured_req.structured_output_key[0]
                == StructuredOutputOptions.STRUCTURAL_TAG
            ):
                # The scheduler will advance the grammar with this step's
                # tokens right away, but the step still contains reasoning
                # content up to and including the end marker. Record where
                # it ends so trim_reasoning_for_advance() can drop it.
                structured_req.reasoning_end_token_index = (
                    self._find_reasoning_end_index(reasoner, all_token_ids, start)
                )
                return True

        return False
`
  );
  const issue24Scheduler = writeFixture(
    issue24Root,
    'v1/core/sched/scheduler.py',
    `            if new_token_ids and self.structured_output_manager.should_advance(request):
                struct_output_request = request.structured_output_request
                assert struct_output_request is not None
                grammar = struct_output_request.grammar
`
  );
  const issue24Script = path.join(hotfixRoot, 'hotfix-dsv4-grammar-advance.sh');
  assert.match(run('bash', [issue24Script], { env: { VLLM_ROOT: issue24Root } }), /Hotfix applied/);
  assert.match(readFileSync(issue24Structured, 'utf8'), /new_token_ids: list\[int\] \| None = None/);
  assert.doesNotMatch(readFileSync(issue24Structured, 'utf8'), /STRUCTURAL_TAG/);
  assert.match(readFileSync(issue24Scheduler, 'utf8'), /new_token_ids=new_token_ids/);
  assert.match(run('bash', [issue24Script], { env: { VLLM_ROOT: issue24Root } }), /already applied/);

  const issue51538Root = path.join(tempRoot, 'issue51538');
  const issue51538Target = writeFixture(
    issue51538Root,
    'v1/attention/backends/mla/indexer.py',
    `def _prepare_uniform_decode_kernel():
    # Compute number of KVs attended to by this token.
    seq_len = tl.load(seq_lens_ptr + req_id)
    per_token_seq_len = seq_len - max_decode_len + local_idx + 1
    tl.store(decode_seq_lens_ptr + idx, per_token_seq_len)

def _prepare_decode_tensors():
                seq_lens_buffer[:] = (
                    seq_lens.unsqueeze(1)
                    - max_decode_len
                    + 1
                    + self.offsets_buffer[:max_decode_len]
                )
                seq_lens = seq_lens_buffer
`
  );
  const issue51538Script = path.join(hotfixRoot, 'hotfix-dsv4-mtp-padding-lengths-51538.py');
  assert.match(run('python3', [issue51538Script, issue51538Target]), /patched/);
  const issue51538Patched = readFileSync(issue51538Target, 'utf8');
  assert.match(issue51538Patched, /tl\.maximum\([\s\S]*local_idx \+ 1, 0/);
  assert.match(issue51538Patched, /self\.offsets_buffer\[:max_decode_len\][\s\S]*\.clamp_\(min=0\)/);
  assert.doesNotMatch(issue51538Patched, /per_token_seq_len = seq_len - max_decode_len/);
  assert.match(run('python3', [issue51538Script, issue51538Target]), /already applied/);

  run('python3', ['-q', path.join(repoRoot, 'test', 'test_dspark_issue31_thinking_budget_gpu.py')]);
  run('python3', ['-q', path.join(repoRoot, 'test', 'test_dspark_suppress_stops_in_reasoning.py')]);
  run('python3', ['-q', path.join(repoRoot, 'test', 'test_dspark_issue55_tool_truncation.py')]);
  run('python3', ['-q', path.join(repoRoot, 'test', 'test_dspark_patch_pack.py')]);

  console.log('dspark hotfix tests passed');

  await import('./qwen38-sglang-recipe.test.mjs');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

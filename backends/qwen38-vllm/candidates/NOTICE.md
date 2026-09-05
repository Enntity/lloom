# Prefix-cache candidate provenance

The two substitutions in `apply-prefix-cache-fix.py` are adapted from
[blazux/qwen3.8-Flash-DGX](https://github.com/blazux/qwen3.8-Flash-DGX/blob/b76890d5a033dd00166c792393d39cf908f56034/src/patch_mamba_block_size.py),
commit `b76890d5a033dd00166c792393d39cf908f56034`.

Copyright 2026 blazux. Licensed under the Apache License, Version 2.0.
You may obtain a copy at <https://www.apache.org/licenses/LICENSE-2.0>.
Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License.

LLooM adds exact-source guards, idempotence, dry-run behavior, validation of both
files before writes, and a CPU regression using source extracted from the pinned
ARM64 image. This patch is **not wired into recipe v4** and is not deployed.
Its LCM shortcut is specific to that image's Qwen group geometry; the upstream
general fixes derive the actual Mamba group size instead (vLLM #53798/#54076).

Promotion requires a paired-host gateway canary: cold and repeated 16K/32K
prompts, cached versus fresh continuation correctness, structured streaming tool
calls, concurrent staggered requests, and clean backend drain. Keep the v4
artifact available for rollback. See `docs/q38fn-upstream-2026-09-05.md`.

import os from "node:os";
import { runCommand } from "./process-control.mjs";

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

async function commandOutput(command, args) {
  const result = await runCommand(command, args, { allowFailure: true });
  if (result.code !== 0) return "";
  return result.stdout.trim();
}

async function cpuBrand() {
  if (process.platform === "darwin") {
    return await commandOutput("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]);
  }
  if (process.platform === "linux") {
    const lines = await commandOutput("/bin/cat", ["/proc/cpuinfo"]);
    return lines.match(/^model name\s*:\s*(.+)$/m)?.[1] ?? "";
  }
  return os.cpus()[0]?.model ?? "";
}

async function commandExists(command) {
  const result = await runCommand("/usr/bin/which", [command], { allowFailure: true });
  return result.code === 0 && Boolean(result.stdout.trim());
}

export async function profileMachine({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  const totalMemoryGb = round(os.totalmem() / 1024 / 1024 / 1024, 1);
  const logicalCpus = os.cpus().length;
  const isAppleSilicon = platform === "darwin" && arch === "arm64";
  return {
    platform,
    arch,
    platformId: `${platform}-${arch}`,
    cpuBrand: await cpuBrand(),
    totalMemoryGb,
    logicalCpus,
    isAppleSilicon,
    modelRoot: env.SWITCHYARD_MODEL_ROOT ?? env.SWITCHYARD_MTPLX_MODEL_ROOT ?? "",
  };
}

export async function evaluateRecipe(recipe, profile, {
  checkCommands = true,
} = {}) {
  const requirements = recipe.requirements ?? {};
  const platforms = Array.isArray(requirements.platforms) ? requirements.platforms : [];
  const requiredCommands = Array.isArray(requirements.commands) ? requirements.commands : [];
  const memoryRequired = Number(requirements.memoryGb ?? 0);
  const platformSupported = !platforms.length || platforms.includes(profile.platformId);
  const memorySupported = !memoryRequired || profile.totalMemoryGb >= memoryRequired;
  const commands = [];
  for (const command of requiredCommands) {
    commands.push({
      command,
      available: checkCommands ? await commandExists(command) : null,
    });
  }
  const missingCommands = commands.filter(command => command.available === false).map(command => command.command);
  const selectable = platformSupported && memorySupported;
  const setupRequired = selectable && missingCommands.length > 0;
  const runnable = selectable && !setupRequired;
  const score = [
    platformSupported ? 50 : 0,
    memorySupported ? 25 : 0,
    missingCommands.length === 0 ? 15 : 0,
    Number(recipe.version ?? 1),
  ].reduce((sum, value) => sum + value, 0);

  return {
    recipeId: recipe.id,
    name: recipe.name,
    platformSupported,
    memorySupported,
    memoryRequiredGb: memoryRequired || null,
    commands,
    missingCommands,
    selectable,
    setupRequired,
    runnable,
    score,
    reasons: [
      ...(platformSupported ? [] : [`requires platform ${platforms.join(", ")}`]),
      ...(memorySupported ? [] : [`requires ${memoryRequired} GB memory`]),
      ...missingCommands.map(command => `missing command ${command}`),
    ],
  };
}

export async function rankRecipes(recipes, profile, options = {}) {
  const evaluations = [];
  for (const recipe of recipes) {
    evaluations.push(await evaluateRecipe(recipe, profile, options));
  }
  return evaluations.sort((a, b) => {
    if (a.selectable !== b.selectable) return a.selectable ? -1 : 1;
    if (a.runnable !== b.runnable) return a.runnable ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return String(a.name).localeCompare(String(b.name));
  });
}

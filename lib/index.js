/**
 * dsh-usd-brep — DSH host plugin that drives the NVIDIA-Omniverse `usd-brep`
 * Python library (NURBS-based BRep solid modeling with native OpenUSD I/O)
 * from a DSH agent via host tools.
 *
 * 插件运行在 profile 的 node_modules 下，解析不到 @deepseek-ai/dsh-tools，
 * 所以【不 import 任何 @deepseek-ai 运行时包】。工具定义直接满足
 * ctx.tools.register() 契约：
 *   { name, description, parameters(标准 JSON Schema),
 *     output:{schema, render}, timeoutMs, execute }
 * 唯一允许的外部依赖是 @deepseek-ai/schemastery（构建 Config 用）。
 *
 * usd_brep 需要 CPython 3.12（wheel 只发 3.12，64 位，Windows/Linux x86_64/
 * aarch64）。插件在本地用 uv 管理的 3.12 解释器创建一个独立 venv
 * （D:\usd-brep\.venv 或 config.venvDir），首次用时 `pip install usd-brep`，
 * 然后 spawn 该 venv 的 python 运行用户传入的 snippet 或对内置示例做
 * BRep 运算并把结果（含导出的 .usda 文件路径）回传。
 */

import { execSync, spawn } from "node:child_process";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import z from "@deepseek-ai/schemastery";

export const name = "usd-brep";
export const inject = ["tools"];

/** 插件配置（zod schema）+ 默认值。apply() 里两者显式合并。 */
export const Config = z.object({
  /** uv 托管的 CPython 3.12 解释器路径（留空则自动探测 py -3.12 / uv）。 */
  pythonExe: z.string().default(""),
  /** venv 根目录；空 = 每用户默认（~/.dsh-usd-brep-venv）；相对路径按 process.cwd() 解析。 */
  venvDir: z.string().default(""),
  /** 是否自动安装 usd-brep（缺省时安装）。 */
  autoInstall: z.boolean().default(true),
  /** 运行 snippet 时的 cwd。 */
  workDir: z.string().default(""),
  /** snippet 执行超时（毫秒）。 */
  timeoutMs: z.number().default(120_000),
  /** 默认要导出的 .usda 文件名（run_example 用）。 */
  defaultUsda: z.string().default("brep_example.usda"),
});

const DEFAULTS = {
  pythonExe: "",
  venvDir: "",
  autoInstall: true,
  workDir: "",
  timeoutMs: 120_000,
  defaultUsda: "brep_example.usda",
};

/** venv 默认目录：每用户稳定位置，与宿主进程 cwd 无关（发布安全）。 */
function defaultVenvDir() {
  return join(homedir(), ".dsh-usd-brep-venv");
}

/** 解析配置里的 venvDir（空 → 每用户默认；相对 → 按 cwd 解析）。 */
function resolveVenvDir(venvDir) {
  if (!venvDir) return defaultVenvDir();
  return isAbsolute(venvDir) ? venvDir : resolve(process.cwd(), venvDir);
}

/* ---------- 小工具 ---------- */

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** 定位 venv 里的 python 可执行文件（Windows 是 Scripts/python.exe，其余 bin/python）。 */
function venvPython(venvDir, isWin) {
  return isWin
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
}

/**
 * 保证 venv 已创建且 usd-brep 已安装；返回该 venv 的 python 可执行文件路径。
 * 需要 CPython 3.12：若 config.pythonExe 给了就用它作为 base 解释器，
 * 否则用 uv 托管的 3.12（Windows 默认位置）或 `py -3.12`。
 */
async function ensureVenv(config, signal) {
  const isWin = process.platform === "win32";
  const venvDir = resolveVenvDir(config.venvDir);
  const py = venvPython(venvDir, isWin);

  if (!(await pathExists(py))) {
    await mkdir(venvDir, { recursive: true });
    const base = await resolvePython312(config, isWin);
    const args = ["-m", "venv", venvDir];
    const venvRes = await runCmd(base, args, { signal });
    if (venvRes.code !== 0 || !(await pathExists(py))) {
      throw new Error(
        `usd-brep: failed to create CPython 3.12 venv at ${venvDir} using ${base} ` +
          `(exit=${venvRes.code}). stderr: ${venvRes.err.slice(0, 500)}`,
      );
    }
  }

  // 幂等安装 usd-brep（用 venv 自己的 pip）。
  if (config.autoInstall !== false) {
    if (spawnSyncProbe(py) === "missing") {
      const pipRes = await runCmd(py, ["-m", "pip", "install", "--quiet", "usd-brep"], { signal });
      if (pipRes.code !== 0) {
        throw new Error(
          `usd-brep: pip install usd-brep failed (exit=${pipRes.code}). ` +
            `stderr: ${pipRes.err.slice(0, 500)}`,
        );
      }
    }
  }
  return py;
}

/** 同步探测 `python -c "import usd_brep"`：ok / missing。用导入的 execSync（ESM 兼容）。 */
function spawnSyncProbe(py) {
  try {
    execSync(`"${py}" -c "import usd_brep"`, { timeout: 30_000, stdio: "ignore" });
    return "ok";
  } catch {
    return "missing";
  }
}

/** 解析可用的 CPython 3.12 解释器路径。 */
async function resolvePython312(config, isWin) {
  if (config.pythonExe && (await pathExists(config.pythonExe))) {
    return config.pythonExe;
  }
  if (isWin) {
    // 常见 uv 托管 3.12 位置（与本机探测一致）。
    const uvPy = join(
      process.env.USERPROFILE ?? "",
      "AppData", "Roaming", "uv", "python",
      "cpython-3.12.14-windows-x86_64-none", "python.exe",
    );
    if (await pathExists(uvPy)) return uvPy;
    // 退而求其次：用 py launcher。
    return "py";
  }
  return "python3.12";
}

/** 运行一条命令并等待退出，返回 { code, stdout, stderr }。 */
function runCmd(cmd, args, { signal, timeoutMs = 300_000, cwd } = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      signal,
      cwd: cwd || undefined,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    if (signal) signal.addEventListener("abort", () => child.kill(), { once: true });
    child.on("error", (e) => rej(e));
    child.on("close", (code) => {
      res({ code, out, err });
    });
  });
}

/* ---------- 内置示例 snippet：建 BRep、布尔差、导出 .usda ---------- */

const EXAMPLE_SNIPPET = `
import json, tempfile, os
import usd_brep

def main():
    sphere = usd_brep.primitives.create_sphere((0.0, 0.0, 0.0), 1.0)
    box = usd_brep.primitives.create_box((0.0, 0.0, 0.0), 1.0, 1.0, 1.0)
    cut = usd_brep.booleans.boolean_difference(sphere, box)  # 缺一个八分体的球
    out = os.environ.get("USD_BREP_OUT", "brep_example.usda")
    usd_brep.usd.export_brep(cut, out)
    (back,) = usd_brep.usd.import_breps(out)
    return {"ok": True, "usda": out, "reimported": 1, "api": "usd_brep 1.0.1"}

print(json.dumps(main()))
`;

const VERSION_SNIPPET = `
import json, importlib
import usd_brep
v = getattr(usd_brep, "__version__", None)
mods = [n for n in dir(usd_brep) if not n.startswith("_")]
print(json.dumps({"version": v, "modules": mods}))
`;

/* ---------- 输出 schema ---------- */

const RUN_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    exit: { type: "number" },
    usda: { type: "string" },
    result: {},
    stderr: { type: "string" },
    message: { type: "string" },
  },
  required: ["ok", "exit"],
};

const VERSION_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    version: { type: "string" },
    modules: { type: "array", items: { type: "string" } },
    message: { type: "string" },
  },
  required: ["ok"],
};

function runBlocks(value, headline) {
  const lines = [headline, `exit=${value.exit}`];
  if (value.usda) lines.push(`usda=${value.usda}`);
  if (value.message) lines.push(value.message);
  if (value.result && value.result !== true && value.result !== "null") {
    lines.push(`result=${typeof value.result === "string" ? value.result : JSON.stringify(value.result)}`);
  }
  if (value.stderr) lines.push(`stderr: ${String(value.stderr).slice(0, 800)}`);
  const out = [{ type: "text", text: lines.join("\n") }];
  return out;
}

function versionBlocks(value, headline) {
  const lines = [headline];
  if (value.version) lines.push(`version=${value.version}`);
  if (value.modules?.length) lines.push(`modules: ${value.modules.join(", ")}`);
  if (value.message) lines.push(value.message);
  return [{ type: "text", text: lines.join("\n") }];
}

/* ---------- 工具定义工厂 ---------- */

function runExampleTool(ctx, config) {
  return {
    name: "usd_brep_run_example",
    description:
      "Run the built-in usd_brep BRep example: create a sphere & box, boolean-difference them, export a .usda and re-import. Returns the usda path and import sanity check.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        usda: { type: "string", description: "输出 .usda 文件路径；默认 config.defaultUsda" },
      },
    },
    output: { schema: RUN_OUTPUT, render: (a, v) => runBlocks(v, "usd_brep example") },
    timeoutMs: config.timeoutMs + 60_000,
    async execute(args, exec) {
      const py = await ensureVenv(config, exec.signal);
      const usda = args.usda || config.defaultUsda;
      const { code, out, err } = await runCmdWithEnv(
        py,
        ["-c", EXAMPLE_SNIPPET],
        { USD_BREP_OUT: usda },
        exec.signal,
        config.timeoutMs,
        config.workDir || undefined,
      );
      let result = null;
      try {
        result = JSON.parse(out.trim());
      } catch {
        result = out.trim();
      }
      const ok = code === 0 && result && result.ok === true;
      return {
        ok,
        exit: code,
        usda: result?.usda ?? usda,
        result,
        stderr: err.slice(0, 1000),
        message: ok ? "sphere-minus-box BRep exported & re-imported" : "run failed — see stderr",
      };
    },
  };
}

function runSnippetTool(ctx, config) {
  return {
    name: "usd_brep_run_snippet",
    description:
      "Execute a user-supplied Python snippet against usd_brep in the managed CPython 3.12 venv. The snippet is `exec`-ed; it must `print(json.dumps(...))` a final JSON value (any object) which is returned as `result`. Set env var USD_BREP_OUT to the .usda path if exporting.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: {
        code: { type: "string", description: "Python source to run (top-level statements allowed)" },
        usda: { type: "string", description: "Optional output .usda path (exported to env USD_BREP_OUT)" },
      },
    },
    output: { schema: RUN_OUTPUT, render: (a, v) => runBlocks(v, "usd_brep snippet") },
    timeoutMs: config.timeoutMs + 60_000,
    async execute(args, exec) {
      const py = await ensureVenv(config, exec.signal);
      const envUsda = args.usda ? { USD_BREP_OUT: args.usda } : undefined;
      const { code, out, err } = envUsda
        ? await runCmdWithEnv(py, ["-c", args.code], envUsda, exec.signal, config.timeoutMs, config.workDir || undefined)
        : await runCmd(py, ["-c", args.code], { signal: exec.signal, timeoutMs: config.timeoutMs, cwd: config.workDir || undefined });
      let result = null;
      try {
        result = JSON.parse(out.trim());
      } catch {
        result = out.trim();
      }
      const ok = code === 0;
      return {
        ok,
        exit: code,
        // DSH 工具桥要求返回值为 lossless JSON：undefined 属性会被整体拒绝，故省略。
        ...(args.usda ? { usda: args.usda } : {}),
        result,
        stderr: err.slice(0, 1000),
        message: ok ? "snippet completed" : "snippet exited non-zero — see stderr",
      };
    },
  };
}

async function runCmdWithEnv(cmd, args, env, signal, timeoutMs, cwd) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
      timeout: timeoutMs,
      signal,
      cwd: cwd || undefined,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    if (signal) signal.addEventListener("abort", () => child.kill(), { once: true });
    child.on("error", rej);
    child.on("close", (code) => res({ code, out, err }));
  });
}

function versionTool(ctx, config) {
  return {
    name: "usd_brep_version",
    description:
      "Probe the managed usd_brep environment: import the module and report its version + available submodules. Installs the venv if needed.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    output: { schema: VERSION_OUTPUT, render: (a, v) => versionBlocks(v, "usd_brep environment") },
    timeoutMs: config.timeoutMs + 60_000,
    async execute(_args, exec) {
      const py = await ensureVenv(config, exec.signal);
      const { code, out, err } = await runCmd(py, ["-c", VERSION_SNIPPET], {
        signal: exec.signal,
        timeoutMs: config.timeoutMs,
        cwd: config.workDir || undefined,
      });
      let parsed = null;
      try {
        parsed = JSON.parse(out.trim());
      } catch {
        parsed = {};
      }
      const ok = code === 0;
      return {
        ok,
        version: parsed.version ?? (ok ? "installed" : "unavailable"),
        modules: parsed.modules ?? [],
        message: ok ? "usd_brep importable" : err.slice(0, 500),
      };
    },
  };
}

/* ---------- apply ---------- */

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
  const definitions = [
    versionTool(ctx, config),
    runExampleTool(ctx, config),
    runSnippetTool(ctx, config),
  ];
  for (const definition of definitions) ctx.tools.register(definition);
}

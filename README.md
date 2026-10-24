# dsh-usd-brep

[English](#english) | [中文](#中文)

DSH 宿主插件：让 DSH agent 通过宿主工具驱动 NVIDIA Omniverse 的 [`usd-brep`](https://pypi.org/project/usd-brep/) Python 库（基于 NURBS 的 BRep 实体建模 + 原生 OpenUSD I/O）。

插件在本地创建并管理一个隔离的 CPython 3.12 venv（usd-brep 的 wheel 只发 3.12，64 位 Windows/Linux x86_64/aarch64），首次使用时自动 `pip install usd-brep`，之后 agent 可以调用三个宿主工具来探测环境、跑内置示例、执行自定义 snippet。

## 中文

### 工具

| 工具名 | 参数 | 说明 |
| --- | --- | --- |
| `usd_brep_version` | （无） | 探测 venv 能否 `import usd_brep`，返回版本号 + 可用子模块列表。 |
| `usd_brep_run_example` | `usda`（可选） | 内置示例：球 − 盒布尔差，导出 `.usda` 并重新导入做 sanity check。 |
| `usd_brep_run_snippet` | `code`（必需）、`usda`（可选） | 执行 agent 写的 Python snippet。约定：snippet 必须 `print(json.dumps(...))` 输出最终 JSON 值，宿主解析后作为 `result` 返回；导出时把 `.usda` 路径传 `usda`（注入到环境变量 `USD_BREP_OUT`）。 |

### 安装

方式一：从本仓库安装（dsh-market 或插件管理器）：

```
dsh plugin add git+https://github.com/gitend/dsh-usd-brep.git
```

方式二：本地目录安装：

```
plugin_manager install_bundle <本地目录>
```

宿主在加载时执行 `apply(ctx, rawConfig)`，注册全部三个工具。

### 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `pythonExe` | `""` | 显式指定 CPython 3.12 解释器；留空则自动探测（uv 托管位置 → `py -3.12`）。 |
| `venvDir` | `""`（= `~/.dsh-usd-brep-venv`） | venv 目录；留空用每用户默认位置（与宿主 cwd 无关）；相对路径按 `process.cwd()` 解析。 |
| `autoInstall` | `true` | 缺失时自动 `pip install usd-brep`。 |
| `workDir` | `""` | 运行 snippet/示例时的 cwd。 |
| `timeoutMs` | `120000` | snippet 执行超时（毫秒）。 |
| `defaultUsda` | `brep_example.usda` | `usd_brep_run_example` 默认输出文件名。 |

### 平台要求

- CPython 3.12（wheel 仅 3.12；Windows 需 MSVC Redistributable）。
- 不要在同一环境混装 `usd-core` 25.11（同版本符号冲突会崩溃）。
- usd-brep 轮子内置 OpenUSD runtime 25.11，模型在库间通过文件交换（不共享 `pxr` 内存对象）。

## English

A DeepSeek Harness (DSH) host plugin that lets DSH agents drive the NVIDIA Omniverse [`usd-brep`](https://pypi.org/project/usd-brep/) Python library (NURBS-based BRep solid modeling with native OpenUSD I/O) through host tools.

The plugin creates and manages an isolated CPython 3.12 venv locally (usd-brep wheels are published for 3.12 only, 64-bit Windows/Linux x86_64/aarch64), runs `pip install usd-brep` automatically on first use, and then registers three host tools for the agent to probe the environment, run the built-in example, or execute custom snippets.

### Tools

| Tool | Parameters | Description |
| --- | --- | --- |
| `usd_brep_version` | (none) | Probes whether the venv can `import usd_brep`; returns the version + available submodules. |
| `usd_brep_run_example` | `usda` (optional) | Built-in example: sphere − box boolean difference, export `.usda` and re-import as a sanity check. |
| `usd_brep_run_snippet` | `code` (required), `usda` (optional) | Runs an agent-supplied Python snippet. Contract: the snippet must `print(json.dumps(...))` a final JSON value, which the host parses and returns as `result`; pass the `.usda` path via `usda` when exporting (injected as env var `USD_BREP_OUT`). |

### Install

From this repository (via dsh-market or the plugin manager):

```
dsh plugin add git+https://github.com/gitend/dsh-usd-brep.git
```

Or from a local directory:

```
plugin_manager install_bundle <local-dir>
```

The host runs `apply(ctx, rawConfig)` on load, registering all three tools.

### Configuration

| Key | Default | Description |
| --- | --- | --- |
| `pythonExe` | `""` | Explicit CPython 3.12 interpreter; empty = auto-detect (uv-managed location → `py -3.12`). |
| `venvDir` | `""` (= `~/.dsh-usd-brep-venv`) | venv directory; empty = per-user default (cwd-independent); relative paths resolve against `process.cwd()`. |
| `autoInstall` | `true` | Auto `pip install usd-brep` when missing. |
| `workDir` | `""` | cwd for snippet/example runs. |
| `timeoutMs` | `120000` | Snippet execution timeout (ms). |
| `defaultUsda` | `brep_example.usda` | Default output file name for `usd_brep_run_example`. |

### Platform notes

- CPython 3.12 (wheels are 3.12-only; Windows needs the MSVC Redistributable).
- Do not install `usd-core` 25.11 into the same environment (symbol conflicts crash).
- The usd-brep wheel bundles the OpenUSD 25.11 runtime; models are exchanged between libraries via files (no shared `pxr` memory objects).

## 许可 / License

MIT（见 LICENSE / see LICENSE）.

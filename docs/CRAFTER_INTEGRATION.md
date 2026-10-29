# Crafter integration

## PTC profile

The PTC adapter invokes the external repository's existing `src.main:main` entry point without modifying that checkout. Keep the engine repository and its Python dependencies in a separate conda environment.

Copy `config/ptc.example.json` to `config/server.json`, then configure:

| Field | Meaning |
| --- | --- |
| `ptc.repo` | Path to the external Crafter/PTC repository |
| `ptc.condaEnv` | Conda environment containing its dependencies |
| `ptc.condaExecutable` | Conda executable name or deployment-specific path |
| `ptc.parser` | `pypdf` for text extraction, or explicitly selected `mineru` |
| `ptc.skipDebug` | Whether to skip the original debug stage; defaults to false |

Run from the web repository root:

```sh
conda run -n crafter-web npm run check:ptc
conda run -n crafter-web npm start
```

The check imports the configured engine entry point and verifies its interface and dependencies. It makes no model requests. Startup performs the same check and rejects submissions when integration is unavailable.

In the interface, select Remote API and enter an HTTPS base URL, model name, and API key. Keys are not prefilled from server credentials, and remote reruns require re-entry. Configure `localModels` to enable a real vLLM endpoint; the default list is empty. Use `apiKeyEnv` to reference server-managed credentials for a local service.

## Processing and publication

1. Parsing reads the uploaded PDF into a task-private working directory. The default pypdf profile extracts selectable text and converts it to the nested page/item structure consumed by the existing PartitionAgent.
2. Running Crafter supplies the selected backend through in-memory configuration and invokes the existing CLI. Keys are passed in the process environment rather than generated YAML or JSON files.
3. Original partition, gap, planning, generation, and debug components remain in the engine checkout. A protocol bridge translates Anthropic-style debug tool messages into OpenAI-compatible requests and adapts supported token-limit parameters.
4. Engine memory, usage records, parser data, and temporary files remain under private `work/`. Generated-code subprocesses receive an environment with provider credentials removed. Wrapped background writers are awaited before publication.
5. Checked code and selected planning artifacts are published under `outputs/codebase` and `outputs/planning`. The success manifest requires nonempty planned files and expected reproduction/dependency files; an upstream fallback script alone does not mark execution successful.

Publication rejects links, sensitive runtime files, and unsafe paths. Conservative name filters can also reject legitimate generated files, including `runtime.py` and paths under `internal/`. This false-positive behavior remains an output-access limitation.

The adapter does not provide operating-system isolation for the engine's debug tools. Use the restricted laboratory deployment intended for this application.

## Parser and model limitations

- **pypdf:** extracts selectable text only. It does not perform OCR, interpret figures, reconstruct tables, or preserve formulas faithfully. Image-only and encrypted inputs fail with an explanation.
- **MinerU:** the optional branch is available as explicit configuration, but execution with actual model assets and target hardware has not been validated. There is no silent fallback to pypdf.
- **Figure analysis:** disabled using the engine's existing `--no-vlm` option in the single-model profile. The separate VLM stage would require additional configuration and credentials.
- **Debug:** enabled by default. Set `skipDebug: true` only as an explicit deployment choice. Any package installation attempted by the existing debug implementation uses its selected conda Python.
- **Costs:** arbitrary provider pricing is unknown. Compatibility counters and unknown-price manifests are not billing estimates and do not imply a free run.

## Generic command integration

For a different Crafter entry point, copy `config/server.example.json` and configure separate `preprocess` and `crafter` command/argument arrays. Supply deployment-specific wrapper paths and working directories. Commands run without shell-string interpolation.

Arguments can use `{input}`, `{work}`, `{output}`, `{model}`, `{baseUrl}`, and `{taskId}`; `{node}` selects the current Node executable when used as the command. Set `expectedOutputs` to relative file paths required for success. An empty list still requires at least one publishable file.

| Environment variable | Value |
| --- | --- |
| `CRAFTER_INPUT` | Independent task PDF path |
| `CRAFTER_WORK` | Private processing directory |
| `CRAFTER_OUTPUT` | Directory for publishable artifacts |
| `CRAFTER_MODEL`, `CRAFTER_BASE_URL` | Selected non-secret model settings |
| `CRAFTER_TASK_ID` | Task marker used for execution and recovery |
| `OPENAI_API_KEY`, `CRAFTER_API_KEY` | Current task key in the child environment |

Wrappers must not persist keys in configurations, caches, logs, or outputs. Do not print environments, enable shell tracing, or put keys in command arguments. Keep private parser/runtime files in `CRAFTER_WORK` and publishable artifacts in `CRAFTER_OUTPUT`. Wait for all task descendants; do not detach processes or remove task markers. Shared vLLM services must be managed separately from task subprocesses.

## Restricted deployment

The server binds to loopback. An SSH tunnel can provide encrypted access:

```sh
ssh -L 3000:127.0.0.1:3000 user@lab-server
```

For a restricted HTTPS reverse proxy, forward the configured loopback Host and set `publicOrigin` to the exact browser-facing origin, for example `https://crafter.lab.example`. The application does not trust arbitrary forwarded-protocol headers. Native HTTPS is available through `tlsCert` and `tlsKey`.

Remote endpoints require HTTPS by default. `remoteAllowedHosts` can restrict provider domains; an empty list permits resolvable public HTTPS hosts and rejects private addresses. Administrator-approved internal or tunnel destinations require an explicit allowlist entry. Allowing HTTP additionally requires `allowInsecureRemote: true` and an independently encrypted connection.

## Acceptance status

Repository import, actual PDF text extraction, compatibility with the real PartitionAgent structure, offline adapter tests, and a small live remote-model connectivity request have been checked. A full paper-to-code run, actual vLLM execution, real MinerU execution, Linux forced-interruption recovery, and scientific correctness remain unvalidated. See [Testing and acceptance](TESTING.md).

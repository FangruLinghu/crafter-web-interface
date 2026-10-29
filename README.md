# Crafter Web Interface

A browser interface for submitting research papers to Crafter, following execution, and retrieving results. The application uses vanilla HTML/CSS/JavaScript, a Node.js server, and SQLite. It runs one task at a time on a single host.

## Features

- Upload one PDF per task, up to 75 MB.
- Select an OpenAI-compatible remote API or an administrator-configured vLLM model.
- Follow queued, parsing, running, completed, and failed tasks with retained logs.
- Reopen shared history, view original PDFs, preview text, and download files or streamed ZIP archives.
- Create independent reruns, withdraw queued tasks, and delete finished tasks after confirmation.
- Enforce configurable runtime, storage, disk-space, and log limits.
- Keep submitted API keys in memory while tasks are queued or running; redact logs and check published outputs.

There are no accounts or task ownership boundaries. All visitors share task history and permitted deletion actions. Use a restricted course or laboratory environment.

## Setup

Requirements: macOS or Linux and conda. The web application requires Node.js 22.13 or later and has no third-party npm dependencies.

Run these commands from the repository root:

```sh
conda env create -f environment.yml
conda run -n crafter-web npm test
conda run -n crafter-web npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Without an integration configuration, the interface and history are available, but task submission is rejected with a setup explanation.

## Configure Crafter

Prepare the existing Crafter/PTC repository, its dependencies, and the actual MinerU runtime and model assets in a separate conda environment. MinerU is the only paper preprocessor. There is no alternate parser fallback. Reproducible engine/MinerU installation and model-asset provisioning still require deployment validation.

1. Copy `config/ptc.example.json` to `config/server.json`.
2. Set `ptc.repo`, `ptc.condaEnv`, and `ptc.condaExecutable` for the deployment.
3. Set `parser: "mineru"` and provision the MinerU model assets and supported hardware/service configuration.
4. Run the integration check and start the application:

```sh
conda run -n crafter-web npm run check:ptc
conda run -n crafter-web npm start
```

The check verifies the configured repository's entry point and importable dependencies without calling a model. Passing it does not establish that MinerU assets, hardware, or the complete engine are operational. Supply a base URL, model name, and API key in the remote-mode form. Configure `localModels` on the server to enable an actual team-managed vLLM endpoint; none is included by default. Store service credentials in environment variables referenced by `apiKeyEnv`, never in configuration files.

See [Crafter integration](docs/CRAFTER_INTEGRATION.md) for adapter behavior, generic command integration, and deployment checks.

## Offline demonstration

```sh
conda run -n crafter-web npm run demo
```

Upload [examples/sample-paper.pdf](examples/sample-paper.pdf) and select the workflow demonstration model. This mode uses explicitly labeled test fixtures. It does not call a model, extract scientific content, or implement the paper. Demonstration data is kept separately under `var/demo`.

## Current status and limits

The application includes task management and an adapter to the existing PTC entry point. The web suite passed 37 tests in a fresh Node.js 22.23.4 environment, and the MinerU adapter suite passed 14 controlled tests. These checks do not verify actual MinerU model execution or a complete paper-to-code run.

MinerU is required for paper preprocessing. Its real model assets, hardware/service setup, and real-paper output have not yet been validated. Full paper-to-code execution, actual vLLM access, target-Linux interruption recovery, and the five-second responsiveness target remain acceptance work. Figure analysis is disabled in the current single-model profile; enabling it is optional and needs separate configuration.

Output publication currently uses conservative filename and directory filters. These can omit legitimate generated code, including files named `runtime.py` or files under `internal/`. This is an outstanding limitation of output access. A completed task also does not certify scientific correctness.

## TODO — deployment acceptance

- [ ] **P0 · Validate real MinerU preprocessing (FR-01–FR-04, NFR-05).** Provision the real assets and supported hardware or service; pass a research PDF through MinerU and verify the required v2 structure, page content, and referenced image files with the actual engine.
- [ ] **P0 · Fix output exclusions (FR-04, FR-07).** Preserve legitimate generated files such as `runtime.py` and `internal/` while excluding private runtime data; require the published manifest, file list, individual downloads, and ZIP contents to match.
- [ ] **P1 · Make setup reproducible (NFR-05, NFR-06).** Document compatible engine/MinerU dependencies, asset acquisition and locations, hardware requirements, and storage needs; reproduce the installation and checks in a clean conda environment.
- [ ] **P1 · Complete a real remote run (FR-01–FR-08, FR-10).** Run a paper from upload through MinerU and Crafter to retained results, previews, and downloads using one supported remote provider.
- [ ] **P1 · Complete an actual vLLM run (FR-02–FR-08).** Configure a team-managed model and verify the complete upload-to-download path without user-managed endpoint credentials.
- [ ] **P1 · Test real execution failures (FR-03–FR-05, FR-07, FR-10, NFR-06).** Verify authentication/service errors, timeout descendants, storage thresholds, queue progress, partial results, retained logs, and downloads with the real integration.
- [ ] **P1 · Verify privacy and Linux recovery (NFR-02–NFR-04).** Check stored records, logs, and downloads for credentials; validate HTTPS or SSH access and forced target-Linux restart cleanup before the next task starts.
- [ ] **P2 · Finish browser and responsiveness checks (UC-01–UC-05, NFR-01).** Exercise submission, monitoring, history/files, rerun, and confirmed deletion/withdrawal in the browser; measure status/log visibility within five seconds under representative load.
- [ ] **P2 · Prepare final deployment and demonstration (NFR-05, UC-01–UC-05).** Verify clean-server setup, publish the operating instructions, demonstrate the required workflows, and update the acceptance report with observed results and remaining limits.

## Configuration and data

Selected defaults are configurable in `config/server.json`. Sizes use decimal bytes; durations use milliseconds.

| Setting | Default | Purpose |
| --- | ---: | --- |
| `maxUploadBytes` | 75,000,000 | Maximum PDF size; cannot exceed 75 MB |
| `taskTimeoutMs` | 3,600,000 | Runtime from the start of parsing, excluding queue time |
| `terminationGraceMs` | 5,000 | Grace period before forced termination |
| `maxTaskBytes` | 2,000,000,000 | Per-task retained and temporary files |
| `maxTotalBytes` | 10,000,000,000 | Application data directory |
| `minFreeBytes` | 1,000,000,000 | Minimum remaining disk space |
| `logMaxBytes` | 2,000,000 | Retained log size |
| `pollIntervalMs` | 2,000 | Browser update interval |
| `maxPreviewBytes` | 262,144 | Maximum text-preview size |

SQLite stores metadata; task directories retain the input PDF, log, private processing files, and checked outputs. ZIP archives are generated on demand without cached archives. Automatic cleanup does not delete retained papers or results to make space. Stop the server before backing up the database and task directories together.

Tasks do not resume automatically after restart. Unfinished tasks receive a failure explanation when safely recoverable. If surviving processes cannot be verified or stopped, execution and deletion remain blocked for administrator review. Remote reruns require the key to be entered again.

The server binds to loopback. For remote use, prefer an SSH tunnel or a restricted HTTPS reverse proxy. Set `publicOrigin` to the exact browser-facing HTTPS origin when using a proxy; see the integration guide. Do not expose the shared application as an unrestricted public service.

## Tests and documentation

```sh
conda run -n crafter-web npm test
# Use the engine environment configured as ptc.condaEnv:
conda run -n ptc python -B -m unittest discover -s test -p 'test_ptc*.py' -v
```

Replace `ptc` with the configured engine environment name. The adapter tests use `PTC_TEST_REPO` to locate the external repository when needed.

- [API reference](docs/API.md)
- [Crafter integration](docs/CRAFTER_INTEGRATION.md)
- [Requirements coverage](docs/REQUIREMENTS.md)
- [Testing and acceptance](docs/TESTING.md)
- [Changelog](CHANGELOG.md)

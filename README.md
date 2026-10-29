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

Prepare the existing Crafter/PTC repository and its dependencies in a separate conda environment, following that project's setup instructions. Then:

1. Copy `config/ptc.example.json` to `config/server.json`.
2. Set `ptc.repo`, `ptc.condaEnv`, and `ptc.condaExecutable` for the deployment.
3. Keep `parser: "pypdf"` for selectable PDF text, or explicitly configure the unvalidated MinerU branch.
4. Run the integration check and start the application:

```sh
conda run -n crafter-web npm run check:ptc
conda run -n crafter-web npm start
```

The check verifies the configured repository's entry point and dependencies without calling a model. Supply a base URL, model name, and API key in the remote-mode form. Configure `localModels` on the server to enable an actual team-managed vLLM endpoint; none is included by default. Store service credentials in environment variables referenced by `apiKeyEnv`, never in configuration files.

See [Crafter integration](docs/CRAFTER_INTEGRATION.md) for adapter behavior, generic command integration, and deployment checks.

## Offline demonstration

```sh
conda run -n crafter-web npm run demo
```

Upload [examples/sample-paper.pdf](examples/sample-paper.pdf) and select the workflow demonstration model. This mode uses explicitly labeled test fixtures. It does not call a model, extract scientific content, or implement the paper. Demonstration data is kept separately under `var/demo`.

## Current status and limits

The application includes task management and an adapter to the existing PTC entry point. Application and adapter tests cover controlled execution and file handling; repository import, actual text extraction, and a small remote-model connectivity request have also been checked. Full real-paper generation, actual vLLM execution, target-Linux interruption recovery, and the five-second responsiveness target remain deployment acceptance work.

The default parser extracts selectable text with pypdf and converts it to the structure expected by Crafter. It provides no OCR, figure interpretation, or faithful formula/table reconstruction. The optional MinerU branch has not been validated with its actual models. Figure analysis is disabled in the single-model profile; the original planning, generation, gap, and debug stages remain enabled.

Output publication currently uses conservative filename and directory filters. These can omit legitimate generated code, including files named `runtime.py` or files under `internal/`. This is an outstanding limitation of output access. A completed task also does not certify scientific correctness.

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

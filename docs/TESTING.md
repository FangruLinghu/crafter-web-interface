# Testing and acceptance

## Run the suites

From the repository root:

```sh
conda run -n crafter-web npm test
conda run -n crafter-web npm run check:ptc
# Replace ptc with the engine environment configured in config/server.json:
conda run -n ptc python -B -m unittest discover -s test -p 'test_ptc*.py' -v
```

The integration check and repository-dependent adapter tests require an installed external PTC checkout. Configure `PTC_TEST_REPO` for tests that need it. The web environment contains Node.js; engine tests run in the separately prepared Python environment. Offline fixtures do not make model calls.

## Application coverage

| Area | Checks |
| --- | --- |
| Uploads and configuration | Single PDF, 75 MB boundary, corrupt inputs, model settings, restricted request origins, and unavailable integration |
| Persistence | SQLite metadata, original PDF retention, shared history, normal shutdown/restart, and independent reruns |
| Scheduling | FIFO execution, one active task, deletion/start races, expected outputs, partial results, and queue progress after termination |
| Process control | Literal arguments, credential-environment isolation, TERM/KILL handling, descendants, and recovery identifiers |
| Storage and files | Task/total/disk thresholds, waiting explanations, traversal and link rejection, safe descriptor reads, output redaction, and crash-temporary-file cleanup |
| Logs | Keys split across chunks, UTF-8, bounded retention, truncation notices, and output without line breaks |
| Downloads | Streamed ZIP integrity, backpressure, disconnects, source-stream cleanup, and deletion cleanup failures |
| Startup | Concurrent stale-lock reclamation and single ownership of the data directory |

Tests use actual HTTP, SQLite, filesystem operations, and controlled subprocesses. Offline execution scripts are labeled demonstration fixtures. ZIP checks also use the platform's `unzip -t` when available. These checks verify the web application and its controlled adapters; they do not certify arbitrary generated code or external model services.

## Adapter coverage

Adapter checks cover configuration and working-directory expansion, real selectable-text PDF extraction, the required input structure, scanned/encrypted input rejection, planned files and success markers, unsafe paths and links, child credential removal, awaited background writes, safe file snapshots, provider tool-message conversion, token parameters, and thinking-text handling.

Recorded development verification included 36 application checks and 13 adapter checks. Repository import, actual single-page text extraction, and a small live MiniMax connectivity request succeeded. The connectivity request did not contain paper or project files and was not a full generation run. Browser checks covered the English interface, empty history, summaries, task dialog, and model-mode switching. Full browser attachment submission was not completed; upload/rerun/deletion API paths are covered by HTTP tests.

## Deployment acceptance still required

- Complete a real paper-to-code run and verify the result manifest and reproduction artifacts.
- Exercise one real remote provider with valid and invalid credentials, unavailable services, and rate limiting.
- Complete the upload-to-download flow with an actual administrator-configured vLLM service.
- Run the optional MinerU branch with real model assets and target hardware; it is currently unvalidated.
- Verify forced interruption, surviving-descendant recognition, termination, and recovery on the target Linux server.
- Measure status/log latency under representative load against the five-second target.
- Check the external engine's credential handling and runtime writes for the deployment configuration.
- Resolve or document output-filter false positives: legitimate generated files such as `runtime.py` or paths under `internal/` can be omitted from downloads and archives.

The default pypdf profile is selectable-text extraction converted to Crafter's required structure, not a validated scientific-document parser. It does not provide OCR or faithful figure, table, or formula recovery. Figure analysis is disabled in the single-model profile. Scientific correctness requires separate evaluation.

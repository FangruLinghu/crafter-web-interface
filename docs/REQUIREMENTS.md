# Requirements coverage

The following identifiers track application scope and implementation coverage. The interface wraps the existing Crafter engine; it does not change its generation algorithms. Accounts, ownership isolation, running-task manual cancellation, distributed execution, and model training are outside scope.

| ID | Implementation | Verification and limits |
| --- | --- | --- |
| FR-01 | `validation.js`: one PDF per task; 75,000,000-byte maximum; header, trailer, and cross-reference checks | Upload boundaries and corrupt/non-PDF inputs are tested; deeper parsing belongs to the configured processor |
| FR-02 | `config.js`, `validation.js`, `runner.js`, and PTC adapters: remote API settings and administrator-managed local models | Repository import and a small remote connection request checked; full paper execution and actual vLLM acceptance pending |
| FR-03 | `scheduler.js` and `runner.js`: independent directories, FIFO queue, runtime limit, and process-group termination | Controlled queue, timeout, descendant termination, and deletion races tested |
| FR-04 | Five task states; successful exit and required published outputs before Completed | Success, failure, and missing expected outputs tested; completion does not certify scientific correctness |
| FR-05 | `logs.js` and browser polling: retained credential-filtered logs with bounded size | Split keys, UTF-8, retention limits, and truncation notices tested |
| FR-06 | `store.js` and `server.js`: SQLite shared history and retained original PDFs | Persistence, normal restart, PDF retrieval, and parameterized queries tested |
| FR-07 | `files.js`, `archive.js`, and browser views: previews, individual files, streamed ZIPs, and partial-output labels | Path/link and credential checks plus ZIP integrity tested; conservative filters can omit legitimate `runtime.py` or `internal/` output files |
| FR-08 | Independent PDF copy, ID, log, and directory for each rerun; remote key re-entry | Reruns remain usable after deletion of the source task |
| FR-09 | Scheduler-coordinated withdrawal and confirmed deletion; failed cleanup remains retryable | Active-task rejection, confirmation, scheduling races, and cleanup-failure persistence tested |
| FR-10 | Classified API errors, retained task error reasons, and logs | Invalid requests and controlled processing/storage failures tested; real provider authentication/network failures require deployment acceptance |
| NFR-01 | Asynchronous subprocesses, bounded log flushing, and two-second browser polling | Basic browser interactions checked; five-second update target requires representative deployment measurements |
| NFR-02 | In-memory credentials, task subprocess environments, log filtering, and checked publication | Test keys excluded from SQLite/logs/downloads; external engine configurations still need deployment review |
| NFR-03 | Loopback binding, origin/Host checks, endpoint validation, file boundaries, and text-only previews | Cross-origin, traversal, and sensitive-file tests; restricted deployment required |
| NFR-04 | Persistent records, explained interruption state, and conservative process recovery | Normal shutdown/restart tested; forced target-Linux interruption acceptance pending |
| NFR-05 | Separate API, database, scheduler, runner, file, and log modules | Configuration examples, setup instructions, and runtime-file exclusions included |
| NFR-06 | Per-task/total/disk thresholds, bounded logs, and archives generated without cached ZIP files | Submission rejection, execution storage limits, waiting reasons, and log limits tested |

## User workflows

| ID | Workflow |
| --- | --- |
| UC-01 | Submit a PDF and review model settings in the new-task dialog |
| UC-02 | Monitor task details, status, and logs; browser closure does not cancel execution |
| UC-03 | Revisit shared history, original PDFs, logs, and available outputs |
| UC-04 | Create an independent rerun from a retained paper |
| UC-05 | Confirm deletion or queued-task withdrawal |

## Integration boundaries

The default PTC parser extracts selectable text using pypdf and converts it to the structure required by Crafter. OCR, faithful formula/table reconstruction, and figure interpretation are not supplied by that profile. The real MinerU branch remains unvalidated; figure analysis is explicitly disabled in the single-model profile. The engine's debug stage remains enabled unless explicitly configured otherwise. Full paper-to-code and actual vLLM execution remain acceptance work.

Implementation defaults are one hour of runtime, 2 GB per task, 10 GB total application data, and 1 GB minimum free space. These are configurable deployment choices, not fixed requirement values. Unfinished tasks do not resume automatically after restart. A withdrawn task with incomplete cleanup remains Failed and excluded from execution; retained papers and results are not automatically deleted to free space.

See [Crafter integration](CRAFTER_INTEGRATION.md), [Testing and acceptance](TESTING.md), and the [API reference](API.md).

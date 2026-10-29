# Changelog

## Unreleased

- Raise interface text contrast to WCAG AA (4.5:1) and set the minimum font size to 11px.
- Add a Failed count to the task summary.
- Reduce the demo banner to one sentence.
- Replace the delete icon with a labeled Delete or Withdraw button.
- Add a progress stepper to task details that marks the stage where a failed task stopped. This adds the `failedStage` column and database schema version 2, with automatic migration.
- Require MinerU for paper preprocessing and remove alternate-parser fallback configuration.
- Add a prioritized deployment and acceptance TODO list with requirement IDs and completion criteria.
- Clarify the limits of offline tests and startup checks for real MinerU and engine execution.
- Verified 37 application tests and 14 controlled adapter tests after the MinerU-only update.

## 0.2.0

- Added a Node.js and SQLite web application with PDF submission, shared task history, live and retained logs, independent reruns, and confirmed deletion or withdrawal.
- Added sequential scheduling, process-group termination, restart handling, runtime limits, storage thresholds, and bounded credential-filtered logs.
- Added checked output publication, read-only previews, individual downloads, and streamed ZIP archives.
- Added an English interface with accessible forms, task details, and model selection.
- Added the PTC integration profile, in-memory model configuration, provider-message adaptation, and startup integration checks.
- Included controlled test fixtures, an explicit offline demonstration, application and adapter tests, and a sample PDF.
- Packaged portable configuration examples, a conda environment specification, and setup, API, integration, requirements, and acceptance documentation.

Known limitations and uncompleted acceptance checks are documented in the README and testing guide.

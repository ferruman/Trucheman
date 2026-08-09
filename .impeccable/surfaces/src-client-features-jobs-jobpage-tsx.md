---
version: 1
slug: "src-client-features-jobs-jobpage-tsx"
primary_target: "src/client/features/jobs/JobPage.tsx"
related_targets: ["src/client/features/jobs/ProgressPanel.tsx","src/client/features/jobs/JobControls.tsx","src/client/features/jobs/ResultPage.tsx"]
---

# Job Workbench

- Scope: the active job route and its progress, control, result, and recovery states.
- Mode: Operate.
- Audience and job: one local user monitoring and controlling one long-running translation job.
- Primary task: understand the current pipeline stage, inspect technical state, and take the next valid action without losing context.
- Content: real job metadata, pipeline progress, current document, segment counts, warnings, results, and connection state.
- Direction: Command Workbench; split operational desk with a compact horizontal pipeline and an always-visible current-state snapshot.
- Memorable moment: the whole EPUB route is readable as one instrument strip while live state remains aligned beside the active operation.
- Constraints: preserve existing actions and semantics; do not invent telemetry; technical detail is visible by default; responsive layout may stack but may not hide data.

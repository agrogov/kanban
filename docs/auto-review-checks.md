# Auto-review checks

A project can tell Kanban to run its own commands around an auto-review card's commit. Both are optional and live in the project config, `<repo>/.cline/kanban/config.json`. Kanban reads the file on each pass, so an edit applies without restarting the runtime. When neither key is present, auto-review behaves as before.

```json
{
  "autoReviewCheck": { "command": "npm run check", "timeoutMinutes": 30, "maxRetries": 1 },
  "autoReviewDoneCheck": { "command": "sh scripts/done-check.sh", "timeoutMinutes": 10 }
}
```

| Key | Runs | On failure |
| --- | --- | --- |
| `autoReviewCheck` | Before Kanban commits the card's work | The output goes back to the task's agent to fix, up to `maxRetries` times in a row (default 1, `0` disables the retry). After that the card waits in review. |
| `autoReviewDoneCheck` | After the card's commit has landed on its base branch | Nothing is sent to the agent. The card stays in review, so the cards linked after it do not start. |

`timeoutMinutes` defaults to 30 for `autoReviewCheck` and 10 for `autoReviewDoneCheck`. A timeout counts as a failure.

## How the commands run

- Each command runs through the shell in the card's task worktree. For the done check, that worktree's `HEAD` is the commit that landed.
- Both get these environment variables, so one project-wide command can tell cards apart:
  - `KANBAN_TASK_ID`: the card's id.
  - `KANBAN_TASK_TITLE`: the card's title.
  - `KANBAN_BASE_REF`: the branch the card lands on.
  - `KANBAN_PROJECT_PATH`: the main checkout of the project.
- Exit code 0 passes. Any other code, a timeout, or a missing worktree fails.
- Kanban keeps only the last part of the output, cleaned of control characters.

## The done check

Use the done check when a card can finish "successfully" in Kanban's eyes while its result is not good enough for the next card. For example, an agent may commit a notes file saying it was blocked. The commit lands, and without a done check the linked cards would start on top of it.

- The result is stored on the card as `doneCheckResult`, with the same fields as `checkResult`: `status` (`running`, `passed` or `failed`), `exitCode`, `timedOut`, `output`, `command`, `startedAt`, `finishedAt`. Its `fingerprint` is the landed commit.
- The board card shows "Running done check…", "Done check failed (exit N), linked cards wait" or "Done check timed out, linked cards wait". `kanban task list` prints the full result.
- Kanban runs the check once per landed commit. A held card stays in review with auto-review on. If more work from the card lands, Kanban checks the new commit.
- If `autoReviewDoneCheck` is present but invalid, Kanban holds every landed card and logs one warning until the config is fixed.

To release a held card, choose one:

- Fix the problem and land a new commit from the card (for example, ask its agent). The check runs again on it.
- Fix the check or its config. Kanban reads the config live, but it does not rerun a check that already ran on the same commit. A new commit, or `--force`, is needed.
- Accept the result as it is: `kanban task done --task-id <id> --force` (or `task move ... --column done --force`). Its linked cards then start.

`kanban task done` and `task move` to done refuse a card whose done check failed, unless `--force` is given. Dragging a card to done in the web UI is a manual decision and is not checked.

## Writing a done check

- Keep it quick and read-only. It runs once per landing, and the next cards wait for it.
- Exit 0 for cards it has nothing to say about. With `KANBAN_TASK_TITLE` or `KANBAN_TASK_ID` you can limit it to the cards it understands.
- Print the reason before failing. That output is what the user sees on the card.

```json
{
  "autoReviewDoneCheck": {
    "command": "id=\"${KANBAN_TASK_TITLE%% *}\"; case \"$id\" in J[0-9]*) sh scripts/prereq-check.sh \"$id\";; *) exit 0;; esac",
    "timeoutMinutes": 2
  }
}
```

## Code map

- `src/config/auto-review-check-config.ts`: parses both keys.
- `src/server/auto-review-check.ts`: runs a command and builds its environment.
- `src/server/auto-review-reconciler.ts`: runs the pre-commit check, and runs the done check in its `landed` branch before completing the card.
- `src/workspace/task-landing-probe.ts`: the reasons `task done` refuses a card.

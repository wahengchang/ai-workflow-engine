# Request routing example

Route an incoming request through a deterministic classifier and an IF gate.
The classifier emits a verdict token; the IF group chooses `approved` or
`rework` by comparing it with `equals` / `elseEquals` in FLOW.json. AWE owns
the routing; the prompts never branch on their own. Run with
`--arg --say=REJECTED` to force the other branch, or `--say=DUNNO` to see
`IF_NO_MATCH`.

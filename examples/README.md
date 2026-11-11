# AWE examples

Three runnable scenarios, each a complete workflow directory. The shared
deterministic executor `executors/reply.cjs` (CommonJS, zero network, no AI
calls) sits beside both workflow roots and is referenced by their `awe.json`
through a relative path, so workflow roots must stay at this level:

```text
examples/
├── README.md           # you are here (outside all workflow scan roots)
├── executors/reply.cjs # shared demo executor
├── content-generation/ # echo-based content workflow (copied by awe init)
├── request-routing/    # IF routing with a numbered, cuttable gate group
└── bounded-review/     # bounded LOOP review
```

## 1. Content generation (echo)

`awe init` copies `content-generation` into a new directory. Default executor
is `echo`; steps reference prior artifacts. See the partial rerun journey below.

## 2. Request routing (IF)

```sh
cd examples
awe run request-routing --json         # classifier default: APPROVED -> 2.1.1
```

- Force the else branch: add `--executor command --command node
  --arg <absolute-path-to-executors/reply.cjs> --arg --say=REJECTED`
- Unexpected verdict: `--say=DUNNO` fails with `IF_NO_MATCH` (both
  `equals` and `elseEquals` are strict on this example).
- The IF group is a numbered group (`2.1-route`), so later partial reruns may
  cut to it and re-execute the whole gate (IF picks one branch); cuts may not
  enter it to rerun only one branch step.

## 3. Bounded review (LOOP)

```sh
cd examples
awe run bounded-review --json         # PASS on third executor call -> loop completes
```

- Bounded failure: `--arg --pass-on=99` never yields PASS; after
  `maxIterations: 3` the run fails with `LOOP_EXHAUSTED`.
- The counter file `.demo-state/verdict.txt` counts executor calls; delete it
  to reset, or pass an explicit `--arg --state=<file>` (absolute path) to
  isolate counters per journey. Partial reruns never inherit old counters.

## Partial rerun journey (content generation)

Edit step content, rerun only the changed suffix without AI contact and
without touching the old run:

```sh
cd examples
awe run content-generation --json                  # full run R1 (echo)
# edit one downstream prompt, e.g. stage-3/3.2-deliver.md
awe run content-generation --from 3.2 --reuse <R1-run-id> --json
```

- Reuses steps `1.1`, `1.2`, `2.1` and the parallel `3.1-checks` group before
  the cut; the new run records `parentRunId`, `from`, and `reusedSteps`.
- Upstream artifacts are copied byte-identical into the new run; template
  `artifact` references resolve to the copies.
- Absolute paths inside older generated artifacts are historical text.
- Cutting to `2.1` reruns from the draft onward; a full `--var` input change
  requires a fresh full run instead (partial runs reject `--var`).

Copy these directories verbatim to reuse them elsewhere; the demo executor
path stays relative and must then be given as an absolute path. Do not place
a `README.md` inside a workflow root: it would be scanned as a prompt.

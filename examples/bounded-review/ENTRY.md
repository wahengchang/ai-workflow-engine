# Bounded review example

A draft is reviewed inside a LOOP group that exits when the verdict step says
PASS, at most `maxIterations` iterations. The example executor answers PENDING
for the first review call and PASS on the second, so the loop completes on the
second iteration (step 1.1 consumes the first executor call). Run with `--arg --pass-on=99` to see the bounded failure
`LOOP_EXHAUSTED`. The counter lives in `.demo-state/verdict.txt`; delete that
file to reset it (it is hidden from workflow discovery either way).

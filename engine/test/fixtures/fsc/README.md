# FSC fixtures

Real FL Studio Score (`.fsc`) files used by the `test_fsc_score_parser` target.

| File                       | Source PPQ | Notes | Notes on contents                          |
| -------------------------- | ---------- | ----- | ------------------------------------------ |
| `FL STUDIO SCORE TEST.fsc` | 96         | > 0   | Authored test score; includes slide notes. |
| `kmb_bass.fsc`             | 96         | 40    | Bassline; includes slide notes.            |

These are checked in as binary test data. The test target receives this
directory as the compile-time define `XLETH_FSC_FIXTURE_DIR` (set in
`engine/CMakeLists.txt`) and parses both files via
`FscScoreParser::parseFile`.

The parser converts source ticks to Xleth's 960 PPQ with
`xlethTick = round(sourceTick * 960 / sourcePpq)`, so at 96 PPQ every source
tick maps to `sourceTick * 10`. The synthetic cases in
`engine/test/test_fsc_score_parser.cpp` cover the byte-level layout, event
walking, untrusted-input guards, and slide/marker handling; these two fixtures
verify the parser against real FL Studio output.

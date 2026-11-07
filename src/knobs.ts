// Every tunable number in one place (BUILD_SPEC.md §8). Shown read-only in the app.
// A knob is a starting point, not a rule: change it here, tell Isaak, and say why.
export const KNOBS = {
  lifeDocWholeUnderChars: 20_000,     // runs read the whole life document while it is shorter than this
  brickIndexWholeUnderChars: 60_000,  // filing reads the index of every brick while it is shorter than this
  contextPackChars: 60_000,           // what a run's gather may pull in
  filingPartChars: 5_000,             // files are split at paragraph breaks into parts of at most this
  backgroundShareOfWeek: 0.5,         // share of the weekly plan allowance background work may use
  rewritesPerPagePerRootPerDay: 1,    // upkeep: one rewrite of a page per root cause per day
  spotChecksPerDay: 3,
  requestReadyAfterRuns: 2,           // or sooner when it blocks something
  nightlyReviewAt: "23:30",           // Europe/Amsterdam; Sundays also look back over the week
  resumeAfterQuietMin: 10,            // background work resumes after Isaak has been quiet this long
  replaySteadyMs: 1_600,              // the view: each replayed step stays lit at least this long
  replayRealCapMs: 6_000,             // the view, real-time replay: long steps capped at this
  // Added by the builder on 7 Nov (rhythm by code; not in the spec's table, so Isaak should look at them):
  upkeepEveryMin: 30,                 // at most one upkeep run this often, when there is something stale or due
  ownTimeEveryMin: 180,               // an open goal with nothing scheduled gets an own-time run at most this often
  bigUploadReceiptChars: 5_000,       // uploads bigger than this get a one-line receipt in the chat at once
  guidesNeedHisYes: false,            // BUILD_SPEC §14, open: may it revise its own self-guides without Isaak's yes? (false = it may; he sees each change)
} as const;
export type Knobs = typeof KNOBS;

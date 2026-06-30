# Decision: adopt trunk-based development

We will move from long-lived feature branches to trunk-based development: short-lived
branches merged to `main` at least daily, behind feature flags when incomplete.

Context: long branches accumulated merge conflicts and hid integration risk until the
end. Reviews ballooned and "big bang" merges caused most of our deploy incidents.

Decision: cap branch life at roughly one day, require green CI before merge, and gate
unfinished work behind flags rather than holding it on a branch.

Consequences: smaller reviews, earlier integration, and a hard dependency on a fast,
reliable test suite and a working feature-flag system. We accept that trade.

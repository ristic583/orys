## Scope and outcome for the owner (required)

**`scope`** — your honest judgement of the work as planned. Orys sizes the rest of the process from it:
- `size`: XS (one tiny change), S (a few small tasks, under ~1 h of agent work), M (a few hours), L (a day), XL (more).
- `risk`: `high` when it changes data, security, money, production behaviour or a large existing system in place; `low` for additive, easily reversible work.
- `ui`: true if the work changes anything people look at.
- `design_directions`: true if `ui` and **how it should look is still open** (a redesign, "make it modern", a new screen without a given layout). Orys will then show the owner 2–3 directions to pick from before building. False when the brief or the existing design already fixes the look.
- `reason`: one or two sentences.

Small and low-risk work gets one phase and one review at the end; large or risky work gets a review after every task. Do not inflate or shrink the scope to get a different process.

**`outcome`** — the owner decides from this. They do not read the plan. Write for a smart person who does not know this codebase, in {{summary_language}}:
- `summary_plain`: what the owner will be able to do or see afterwards. No jargon, no file or class names. 2–5 sentences.
- `you_will_see`: concrete, observable changes: where (screen, command, page) and what exactly. A change that only exists in code, tests or CI does NOT go here.
- `stays_the_same`: things the owner might expect to change but will not. Say it plainly when the look and layout stay the same.
- `visible_change`: be honest. Tests, refactors, CI and backend-only work are `none` or `little`.
- `to_see_it`: what must happen before the owner can see it (deploy, migration, env var). Empty only if it is visible right after the merge.
- `open_questions`: only questions whose answer changes what gets built, each with the answer you will use if the owner does not reply.

Never promise what the plan does not build: at the end the owner checks the result against `you_will_see` and `stays_the_same`.

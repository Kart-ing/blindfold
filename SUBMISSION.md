# Private Finance Agent

**The cloud model does the reasoning. Your Mac does the knowing.**

You text a finance agent from your phone: "Can I buy a $400 jacket?" It answers in seconds: "Tight, but doable. You're $155 behind on your $10k June goal, and the $400 would push it to July." Then it says what would work: anything under $40, or skipping 12 delivery dinners. Your bank data, receipts, partner's spending and home address stay on your Mac. **Only symbols ever leave your Mac.** One cloud model helps with language and planning, never with your data: OpenAI's GPT-6.1 Sol listens (it understands what you text and words the replies) and plans open-ended questions, and the Mac computes. Sol sees symbols like `MERCHANT_4`, `Q_AMT_1` and `{GAP}` instead of real values. No model runs on the Mac: privacy there is plain code. A symbolizer swaps every value from your data for a symbol, the Mac computes every number and fills the real values in, and a leak canary checks every byte before it leaves.

**The cloud model provider never receives a real value from your data unless you approve that one value.** An independent red team plus a code review found **34 leaks over six rounds, and all are fixed**. None of the **81 attacks** now gets through, whether the user types a value or not. Passing 81 attacks is evidence, not proof. Every attack stays in the suite as a regression test (`test/redteam.test.ts`).

## The problem

People paste bank statements into chatbots because budgeting apps can't answer real questions. That sends every merchant, amount and account number to an AI company. Shared cards make it worse. Half the charges on a couple's Amex are someone else's, so the numbers are wrong as well as exposed.

## What it does

| Use case | Example | What leaves the Mac |
|---|---|---|
| Can I buy this? | "Can I buy a $400 jacket?" → "Tight, but doable", the pace gap against a savings goal, and what would work (anything under $40, or skipping 12 delivery dinners) | The question as symbols (`Q_AMT_1` for the price) to Sol, then placeholder names and a number-free situation ("tight, behind pace") so Sol can word the reply. The math stays local |
| Proactive nudges | `tick 08:30` → "$449 on office-commute Ubers this month (17 rides). Train 3 days instead and you'd keep about $143 (at $2.50 a ride)." / `tick 17:30` → "Skip DoorDash tonight? Goal is $158 behind pace. A delivery dinner runs you about $30. …" | Nothing |
| Who paid on a shared card | A WORK→HOME Uber is mine (receipt match). Apple Pay on the Amex is hers. An unclear $159 charge triggers "Quick one: was that $159 Nordstrom yours? 1 me · 2 her · 3 split" | Nothing |
| Product research | "Look at its reviews and tell me if it's worth it" | Only the symbolized question, in one web-search call to Sol: brand names and model numbers go, your data's people, amounts and stores don't (a store from your history only with consent). Links come back as source names |
| Open-ended questions | "What changed in my spending since August?" | The question as symbols, to Sol twice: once to understand it, once to plan it. The Mac runs the plan and computes the answer |

## Architecture

```
iMessage (owner's number only) ─▶ router ─▶ commands, 1/2/3 answers, greetings: local
                                     │      any other text ─▶ symbolize ─▶ egress() + leak canary ─▶ OpenAI
                                     │
        ┌────────────────────────────┼─────────────────────────────┐
   T0 local code                 Sol: conversation             Sol: planning (open-ended questions)
   SQLite + TypeScript           understands the text:         ◀─ JSON plan (whitelisted DSL)
   ingest, receipt match,        whitelisted actions over      ─▶ executed locally over SQLite
   attribution, affordability,   symbols; words replies as     ─▶ answer template filled locally
   nudges, every number          placeholder-only templates
                                     │
                    ledger (one row per answer) ─▶ panel at 127.0.0.1:4545
```

- **Data in.** Bank data comes from Plaid, or from a seeded 3-month fixture for the demo. Ride and food receipts come from email (fixture .eml files, or the local Apple Mail store). Four regex parsers cover Uber, Lyft, Uber Eats and DoorDash. Each pickup and dropoff is geofenced to `HOME`/`WORK`/`OTHER` within 250 m, and only the label is stored.
- **Attribution.** Each charge on the shared card gets an owner from the first rule that fires: user label, then Apple Pay on Amex (hers), then a HOME↔WORK ride receipt, then single-person or multi-person food orders, then weekday work hours, then a default. Weak guesses over $75 trigger an iMessage prompt, and the answer becomes a permanent user label.
- **Cloud path.** The question is symbolized. The planner is GPT-6.1 Sol via the OpenAI API (cloud model provider: OpenAI). `egress()` is the only network path to it, and it scans the serialized payload against every real merchant, amount form, account mask, person, address and memo in SQLite. Any hit blocks the call. The planner returns a plan in a 10-op DSL. The plan is validated against a whitelist and executed with parameterized SQL. Real values are filled into the reply only on the Mac.
- **Privacy is local code, not a local model.** Every text bound for either cloud model is symbolized on the Mac first: each merchant, amount form, account mask, person, address and memo in SQLite becomes a symbol, an unknown street address becomes `ADDR_n`, and a name the Mac has never seen becomes `PERSON_n` (and stays a symbol after that) when it's capitalized, sentence openers included, unless it's a common word, a month, a weekday, an acronym or part of a known merchant, or when it follows a relationship or money word ("my friend zorya", "I sent zorya the rent"). People named in Venmo and Zelle payments count as your data. The leak canary then scans every byte of the serialized request against every value in SQLite and blocks the call on any hit. A local PII classifier (`src/cloud/gate.ts`, Laya) exists but is switched off (`PRIVACY_GATE=off`): the agent runs no local models.
- **Conversation.** With `VOICE=cloud` (the live setting), every text that isn't a command goes to the conversation model as symbols: GPT-6.1 Sol with low reasoning (`OPENAI_CONVERSE_MODEL` can point it at gpt-6-luna, which is off) ("set my goal to Q_AMT_1 by june"), along with the last four turns, symbolized again (quantities renamed `PRIOR_*`) inside the same canaried message and kept only in memory. It returns a few whitelisted actions (set a goal, remember something, add an asset, ask a known question), with amounts only as symbols from the message, which the Mac carries out and answers from local numbers. It words the reply as a template of placeholder names; the Mac rejects any template containing a digit or "$" and fills in the values itself. Commands (`ledger`, `rules`, `goal …`, `stop nudges` …), 1/2/3 answers, memory commands, greetings and "what is <merchant>?" never reach it, and any failure (canary block, provider error, a timeout (9 s to understand; 4 s to word unless `LUNA_PHRASE_MS` sets more), invalid output) falls back to keyword routing on the Mac; the attempt is still logged in the ledger, with its canary hits. Each answer still writes one ledger row, with the conversation calls merged in.
- **Product research.** "Is it worth it" questions are one OpenAI Responses call with web search on the configured model (Sol), with `store: false` and no user or location. It carries only the symbolized question: no history, memories or account data. Amounts you type go as a word range, people the data knows and cued names stay symbols, a store from your history goes out only if you approve it, and her merchants never do. The reply is cleaned on the Mac: links become source names, and a sentence quoting a number from your data that you didn't type is dropped.
- **Consent.** If the planner needs an exact number, the user is asked over iMessage. If they refuse, the cloud gets a bucket in words ("two hundred fifty to five hundred dollars").
- **Ledger.** One row per answer records the tier, the symbolized question, the exact payload sent, and the canary result. Texting `ledger` replies with something like "5 questions, 4 never left your Mac, 0 exact values sent."

## Privacy claims and the tests that prove them

Run `bun test`: 0 failing. Each claim below is backed by a passing test, named exactly as in the file.

| Claim | Test (file › test name) |
|---|---|
| Ride and receipt addresses are stored in no database column, only HOME/WORK in `places` and the raw .eml file | `test/ingest.test.ts` › seeded fixture › raw addresses appear in no DB column (only places, for HOME/WORK, and the .eml at raw_path) |
| Endpoints become HOME/WORK/OTHER labels (250 m); unknown addresses are OTHER | `test/ingest.test.ts` › geofence: 250m radius, unknown address -> OTHER |
| Setting home/work never geocodes over the network; unknown addresses are refused | `test/attribution.test.ts` › setPlace › unknown address -> ok:false, places unchanged |
| `egress()` is the only code that reaches an LLM over the network | `test/cloud.test.ts` › egress › is the only code that reaches an LLM over the network |
| A canary hit blocks the call before the network | `test/cloud.test.ts` › egress › a hit blocks: the provider is never called |
| Real values are blocked plain, upper-cased, or nested inside JSON strings and tool names | `test/cloud_adversarial.test.ts` › egress called directly › [merchant, amount, amount cents, mask, person, home, receipt address, memo]: plain, upper-case, and JSON inside a nested string are all blocked |
| Merchants, amounts, masks, people and addresses in a question are symbolized or blocked | `test/cloud_adversarial.test.ts` › (a) the question; › (a') near-miss spellings; `test/redteam.test.ts` › redteam: should hold |
| The static system prompt trips nothing in the canary | `test/cloud.test.ts` › canary › static system prompt + schema + category list: 0 hits against the full fixture |
| The prompt-injection memo never reaches the cloud | `test/cloud_adversarial.test.ts` › the injection memo never goes to the cloud: memo text is answered on the Mac |
| Memos and receipts are never read by the plan executor; only the canary reads raw addresses | `test/cloud_adversarial.test.ts` › structure › the executor never reads memos or receipts; › only the canary reads raw receipt addresses |
| Multi-step results go back as symbols and bucket words only | `test/cloud_adversarial.test.ts` › (b) › a merchant list goes back as symbols + bucket words only |
| A malicious planner can't tell whether a value is in your data: a real and a made-up guess get the same behaviour, and our turns only repeat text the planner wrote itself | `test/cloud_adversarial.test.ts` › no membership oracle: a planner guessing a real vs a made-up merchant sees the same behaviour (codex #7); › retry path: no membership oracle (eng1 round 5); `test/redteam.test.ts` › redteam: round 5 (assistant-turn exemption) › assistant turns carry only strings the provider already said |
| The filled-in reply never appears in any payload | `test/cloud_adversarial.test.ts` › (c) › the locally filled reply never appears in any payload |
| Consent denied → only a bucket word leaves; consent once → exactly that value and nothing else | `test/cloud_adversarial.test.ts` › (d) disclose › consent denied: only a bucket word leaves, never the number; › consent once: exactly the approved value leaves, nothing else real |
| No answer or timeout on a consent prompt means deny | `test/imessage-consent.test.ts` › timeout → deny, prompt answered='timeout'; `test/cloud_adversarial.test.ts` › no consent engine wired (or timeout) → deny |
| Hostile plans are rejected and the SQL is parameterized | `test/cloud_adversarial.test.ts` › DSL rejects hostile plans; › executor is parameterized: a hostile value that skipped validation is inert |
| Her charges never move my numbers or appear in plan results | `test/handlers.test.ts` › her charges never move the number; `test/cloud.test.ts` › her charge never shows, even as a merchant symbol; `test/spend_query.test.ts` › top merchants in a named month; her merchant never appears |
| Her charges never trigger nudges | `test/nudges.test.ts` › her rides never count; › her deliveries don't count; › her charges → no |
| Apple Pay on the Amex is hers, even on a weekday at 11am | `test/attribution.test.ts` › rule 2: Apple Pay on Amex at 11am on a weekday is hers (beats work hours) |
| User corrections are never overwritten by re-attribution | `test/attribution.test.ts` › rule 1 beats rule 2, and attributeAll never overwrites user labels |
| Every number in a reply is computed in code: the conversation model only writes placeholder templates, which are rejected if they contain a digit or "$", and it never sees a value | `test/handlers.test.ts` › afford reply: verdict first, then why, then computed options (VOICE=plain); `test/cloud_converse.test.ts` › names and a number-free situation are all that leave; a valid template comes back; › a situation with a number, or a bad placeholder name, never leaves |
| No local model runs: unless `LOCAL_MODELS=on`, nothing the agent or the data importer does spawns Apple's on-device model (`bin/fm`) | `test/imessage-nolocal.test.ts` › a full set of messages and a nudge tick never spawn bin/fm, even with the real fm passed in; › positive control: with LOCAL_MODELS=on and VOICE=device, phrase does spawn it; `test/ingest-nolocal.test.ts` › the importer never spawns bin/fm unless LOCAL_MODELS=on: rules, regexes and the cache only; › positive control: with LOCAL_MODELS=on the importer does spawn it |
| One cloud model: conversation runs on the configured planner model (GPT-6.1 Sol by default); gpt-6-luna is only a setting | `test/cloud_converse.test.ts` › the converse model is the configured one (OPENAI_MODEL, GPT-6.1 Sol by default); Luna stays a setting |
| The conversation model receives only symbolized text, placeholder names and a number-free situation, and the history keeps no values | `test/imessage-luna.test.ts` › what Luna receives: symbolized text, placeholder names and a number-free situation; history keeps no values |
| Conversation history is symbolized again (quantities renamed `PRIOR_*`) inside the canaried message, and real values come back only on the Mac | `test/cloud_converse.test.ts` › (a) goal + remember: real cents and a desymbolized note come back; only symbols went out; › history is symbolized again, its quantities renamed PRIOR_*, and it rides in OUR (canaried) user turn |
| The conversation model runs only with `VOICE=cloud`, and commands, 1/2/3 answers, memory commands and greetings never reach it | `test/imessage-luna.test.ts` › exact commands, 1/2/3, memory commands and greetings never call Luna; › VOICE=plain turns Luna off entirely; › VOICE=device (on-device wording) never calls Luna either: the cloud is an explicit opt-in |
| A conversation template containing a digit is rejected, and the Mac's own text is sent | `test/imessage-luna.test.ts` › an invalid Luna template (digits) → the local fallback text, still one ledger row |
| A name the Mac has never seen becomes `PERSON_n` before anything leaves when it's capitalized or follows a relationship or money word ("Zorya covered dinner", "lunch with Zorya on friday", "I sent zorya the rent", "split it with zorya"); everyday sentences don't trigger it; the reply restores the name on the Mac | `test/cloud_converse.test.ts` › names the DB has never seen (eng1's probes, empty DB) › %s → PERSON; › no false person: %s; › with an empty DB the live sentence carries PERSON_1, never the name; the reply restores it locally |
| People named in Zelle payments are symbolized like any other value from your data | `test/ingest-p2p.test.ts` › the import keeps the name in the memo, the backfill restores it by the same ids, and a text naming them is symbolized |
| Runway questions ("how long would I last if my income stops Jan 1") are answered by local math, never by the planner | `test/runway.test.ts` › live a→b→c through Luna: runway answers, one memory row, no duplicate asset, never the planner; › Luna off (VOICE=plain): the same sentences answer locally, tier local |
| Product research sends only the symbolized question (no history, memories, masks or addresses); people the data knows stay symbols, brands and model numbers go; her merchants never leave | `test/cloud_research.test.ts` › the human's sentence: one Responses call with web search, the configured model, nothing stored, no price; › a person the data knows, and names after a person cue, stay symbols; brands and model numbers go; › masks, addresses, memories and earlier turns don't ride along; an injection asking for them gets only the question; › her merchants never leave, not even with consent |
| A store from your history goes out in research only with consent; the reply is cleaned locally | `test/cloud_research.test.ts` › a store from history goes out only with consent, as the user typed it; a no sends nothing; › links → source names, echoed symbols → words, and a sentence with a number from the data (not typed) is dropped |
| Every answer writes exactly one ledger row; blocked calls are reported | `test/imessage.test.ts` › every answer writes exactly one row with tier and intent; › ledger reports blocked canary calls |
| Only the owner's direct messages are accepted | `test/imessage-kit.test.ts` › delivers only the owner's direct messages, once each; `test/imessage.test.ts` › rejects other number, isFromMe, group, empty text |
| The owner's handle is never printed in full | `test/imessage-kit.test.ts` › maskHandle and selfCheck never print the full handle |
| Nudges respect quiet hours and at most 2 a day | `test/nudges.test.ts` › quiet hours: 22:00 and 07:59 nothing, 08:00 ok; › max 2 per local day; next day allowed |

## Honest notes

- **Plaid and email see what they already see.** Your bank already knows your transactions, and Plaid relays them. Receipts are read from your local mailbox. The cloud model provider never sees either.
- **One party sits outside the Mac on the cloud path:** OpenAI, which runs GPT-6.1 Sol for both conversation and planning. They see only what each payload carries: symbolized messages (the conversation call also gets the last four turns, symbolized), placeholder names such as `{GAP}`, number-free situation words such as "tight, behind pace", the static prompts, bucket words, counts, yes/no results, and any exact value you approved for one question. They never see an amount, merchant, person, address, account number or memo that the Mac knows about (see below).
- **A lowercase new name is the weak spot.** With no local model, the Mac knows names from your data (merchants, people in Venmo and Zelle payments), from capitalization and from cue words. A lowercase name it has never seen, with no cue word before it ("lunch with zorya"), still goes out as typed, and the canary can't block a name it has never seen. The rule fails toward symbolizing: a capitalized brand that isn't in your data becomes `PERSON_n` too, which is safe but tells the model it's a person.
- **Generic words from messy bank merchant names pass by design.** A single everyday word such as "plan" or "card payment" identifies nothing alone; the full names are still blocked or symbolized (`test/cloud.test.ts` › their full names still block or get symbolized; generic fragments alone identify nothing).
- **Research sends brand names to a web search.** A product question is meant to leave: brands and model numbers go as typed, and so does a friend's name with no cue word ("is the one Zorya recommended worth it"). The canary also skips JSON number literals, because those are protocol settings: a live call was blocked because `max_output_tokens: 3000` matched a real $30.00 charge. The same digits in text still block (`test/cloud_research.test.ts` › egress: protocol numbers aren't data (live: max_output_tokens 3000 = a real $30.00 charge blocked the call); the same digits in text still block).
- **Situation words are information too.** Sol learns how things stand ("tight", "behind pace", "options: price ceiling, skip deliveries"), never by how much. Bucketed and yes/no results sent back to the planner are counted as "partial" in the ledger.
- **No open leaks, as far as 81 attacks can tell.** `test/redteam.test.ts` holds 81 attacks from six rounds: three red-team rounds (19 leaks found), a code review (12), a round on the retry path (3), and a final sweep of every field a planner controls (0). Every leak found is fixed and stays as a regression test, and every attack runs against the exact request body sent to OpenAI (and the Bedrock format). A future attack nobody tried could still get through.
  - *Data leaving without the user typing it*: the planner could once learn whether you shop at a merchant from whether a follow-up call arrived (a canary block on its own echoed words). Now our turns never quote model-supplied text, and the call pattern is the same for real and made-up values across every planner-controlled field. Every assistant turn we send contains only text the provider wrote itself (tested).
  - *A word the user types that matches their data*: covered by first words and endings of merchant names, memo words, surnames, look-alike letters, digits for letters, spelled-out and non-Latin numbers, and street-suffix abbreviations.
  - Questions that name only her merchants are answered locally with a refusal and never sent. Open-ended questions with no real values still reach the planner (`test/redteam.test.ts` › redteam: utility (not over-blocked)).
- **Apple Pay detection on real Amex data is unverified.** Plaid's transaction object has no wallet field. Amex prints "AplPay <merchant>" on statements, and `src/ingest/plaid.ts` reads that prefix. We have not confirmed that Plaid passes it through. Without it, real data falls back to asking the user who paid.
- **`VOICE` decides whether the cloud model listens.** `cloud` (the live setting): Sol understands texts and words replies over symbols. `plain`: no model at all; replies are the computed templates and routing is by keywords, which is what `bun run rehearse` checks word for word. `device` only means something with `LOCAL_MODELS=on`, an opt-in experiment with Apple's on-device model that is off by default.
- **The demo runs on a seeded synthetic dataset** (Aug 1 – Oct 22, 2026), not a live bank account. The Plaid adapter has not been run against the live API.

## Run it

```
bun install
bun run demo          # reseed, then panel (127.0.0.1:4545) + agent (--cli, or --live with OWNER_HANDLE in .env)
bun run demo:reset    # reseed between rehearsals
bun run rehearse      # pre-stage check: plays DEMO.md's beats on a throwaway database
bun test
```

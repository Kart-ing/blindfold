import { expect, test } from "bun:test";
import { openDb } from "../src/db";
import { handle, ownerFrom } from "../src/handlers/attribution_fix";

const NOW = 1792695600;
function db() {
  const d = openDb(":memory:");
  d.run("INSERT INTO accounts(id, name, type, shared, owner) VALUES ('amex','Amex','credit',1,'shared'),('visa','Visa','credit',0,'me')");
  d.run("INSERT INTO transactions(id, account_id, ts, amount_cents, merchant) VALUES ('u1','amex',?,4275,'Uber'),('u2','amex',?,1800,'Uber'),('n1','amex',?,15900,'Nordstrom'),('v1','visa',?,999,'Uber Eats')",
    [NOW - 86400 * 5, NOW - 86400 * 2, NOW - 86400 * 9, NOW - 3600]);
  d.run("INSERT INTO attributions(txn_id, owner, rule, confidence, needs_prompt) VALUES ('u1','me',7,0.5,1),('u2','me',3,0.9,0),('n1','me',7,0.5,1)");
  return d;
}
const owner = (d: any, id: string) => (d.query("SELECT owner, labelled_by_user u FROM attributions WHERE txn_id = ?").get(id) as any);

test.each([["the uber was hers", "her"], ["that was not mine", "her"], ["split the doordash", "shared"], ["that one was mine", "me"], ["what?", null]])
  ("ownerFrom(%s)", (t, o) => expect(ownerFrom(t as string)).toBe(o as any));

test("names a merchant → relabels its latest shared charge", async () => {
  const d = db();
  const r = await handle(d, "the uber was hers", { now: NOW });
  expect(owner(d, "u2")).toEqual({ owner: "her", u: 1 });
  expect(owner(d, "u1").owner).toBe("me");
  expect(r.text).toBe("Got it: the $18 Uber on Oct 20 is hers, so it won't count toward your spending.");
});

test("no merchant named → the last who-paid question's charge, and the question closes", async () => {
  const d = db();
  d.run("INSERT INTO prompts(kind, ref, text, sent_ts) VALUES ('who_paid','n1','Was Nordstrom $159 yours?',?)", [NOW - 60]);
  await handle(d, "oh that one was hers actually", { now: NOW });
  expect(owner(d, "n1")).toEqual({ owner: "her", u: 1 });
  expect((d.query("SELECT answered FROM prompts").get() as any).answered).toBe("her");
});

test("personal-card merchants aren't relabeled; unclear text asks", async () => {
  const d = db();
  expect((await handle(d, "uber eats was hers", { now: NOW })).text).toContain("Got it: the $18 Uber"); // matches shared "Uber", not the personal Uber Eats
  expect((await handle(d, "huh", { now: NOW })).text).toStartWith("Which charge, and whose?");
});

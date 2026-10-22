// A self-harm mention gets a caring, fixed, local reply: never a feature list, never the cloud, never a nudge.
// Matching is deliberately broad (hyperbole like "chat should i kill myself" included): a false positive costs one
// kind message; a miss costs much more.
const SELF_HARM = new RegExp([
  String.raw`kill(?:ing)?\s+my\s?self`, String.raw`kill\s+me`, String.raw`kms`, String.raw`suicid(?:e|al)`,
  String.raw`end(?:ing)?\s+(?:it\s+all|my\s+life)`, String.raw`(?:want|wanna|going)\s+to\s+(?:die|disappear)`, String.raw`wanna\s+(?:die|disappear)`,
  String.raw`no\s+(?:point|reason)\s+(?:in\s+)?(?:living|to\s+live)`, String.raw`self[-\s]?harm`, String.raw`hurt(?:ing)?\s+my\s?self`, String.raw`unalive`,
].map((p) => `\\b${p}\\b`).join("|"), "i");

export const mentionsSelfHarm = (text: string) => SELF_HARM.test(text);

export const SAFETY_REPLY =
  "I'm really sorry it feels that heavy. You matter way more than any number in this chat.\n" +
  "If you're thinking about hurting yourself, please reach out now: call or text 988 (Suicide & Crisis Lifeline, US), or text HOME to 741741.\n" +
  "Whenever you want, we can work on the money side together, one step at a time.";

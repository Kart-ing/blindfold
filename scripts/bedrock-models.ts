// Lists GLM models (and inference profiles) your Bedrock API key can see, so BEDROCK_MODEL_ID can be filled in, and
// says whether each one is actually usable (agreement, authorization, entitlement, region).
// Usage: bun run scripts/bedrock-models.ts [filter]   (default filter "glm"; e.g. "anthropic" to look for a backup model)
//        Reads AWS_BEARER_TOKEN_BEDROCK, AWS_REGION and BEDROCK_MODEL_ID from .env.
// Bedrock control plane only (never the inference endpoint): no prompt, no data. The only host this script may call.
const token = process.env.AWS_BEARER_TOKEN_BEDROCK, region = process.env.AWS_REGION ?? "us-east-1";
const consolePath = `https://${region}.console.aws.amazon.com/bedrock/home?region=${region}#/model-catalog (search "GLM"; the model id is on the model's page)`;
if (!token) {
  console.error(`AWS_BEARER_TOKEN_BEDROCK is not set (add it to .env). Or find the id in the console: ${consolePath}`);
  process.exit(2);
}

async function get(path: string): Promise<{ ok: true; json: any } | { ok: false; status: number; text: string }> {
  try {
    const res = await fetch(`https://bedrock.${region}.amazonaws.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok ? { ok: true, json: await res.json() } : { ok: false, status: res.status, text: (await res.text()).slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, text: String((e as Error).message ?? e) };
  }
}

const label = process.argv[2] ?? "glm";
const GLM = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
let found = 0;
const candidates: string[] = [];

const models = await get("/foundation-models");
if (models.ok) {
  const hits = (models.json.modelSummaries ?? []).filter((m: any) => GLM.test(`${m.modelId} ${m.modelName} ${m.providerName}`));
  console.log(`Foundation models matching /${label}/i in ${region}: ${hits.length}`);
  for (const m of hits) {
    candidates.push(m.modelId);
    console.log(`  ${m.modelId}  (${m.providerName} ${m.modelName}; status ${m.modelLifecycle?.status ?? "?"}; inference ${(m.inferenceTypesSupported ?? []).join("/") || "?"})`);
  }
  found += hits.length;
} else {
  console.log(`Could not list foundation models (HTTP ${models.status}): ${models.text}`);
}

// Some models are only invocable through an inference profile id (e.g. "us.<provider>.<model>").
const profiles = await get("/inference-profiles?maxResults=1000");
if (profiles.ok) {
  const hits = (profiles.json.inferenceProfileSummaries ?? []).filter((p: any) => GLM.test(`${p.inferenceProfileId} ${p.inferenceProfileName}`));
  console.log(`Inference profiles matching /${label}/i: ${hits.length}`);
  for (const p of hits) console.log(`  ${p.inferenceProfileId}  (${p.inferenceProfileName}; status ${p.status ?? "?"}; type ${p.type ?? "?"})`);
  found += hits.length;
} else {
  console.log(`Could not list inference profiles (HTTP ${profiles.status}): ${profiles.text}`);
}

if (!models.ok && !profiles.ok) {
  console.log(`\nThis bearer token can't list models (it may be scoped to invoke only). Find the id in the console instead:\n  ${consolePath}`);
  process.exit(1);
}
// Why a listed model may still answer "Operation not allowed": per-model availability for this account.
const configured = (process.env.BEDROCK_MODEL_ID ?? "").replace(/^(us|eu|apac|global|us-gov)\./, "");
for (const id of [...new Set([configured, ...candidates].filter(Boolean))].slice(0, 6)) {
  const a = await get(`/foundation-model-availability/${encodeURIComponent(id)}`);
  if (!a.ok) { console.log(`Availability of ${id}: could not check (HTTP ${a.status}): ${a.text}`); continue; }
  const j = a.json, agreement = j.agreementAvailability?.status ?? "?";
  console.log(`Availability of ${id}: agreement ${agreement}${j.agreementAvailability?.errorMessage ? ` (${j.agreementAvailability.errorMessage})` : ""}, authorization ${j.authorizationStatus ?? "?"}, entitlement ${j.entitlementAvailability ?? "?"}, region ${j.regionAvailability ?? "?"}`);
  if (agreement !== "AVAILABLE") console.log("  → accept the model's offer in the console: Model catalog → the model → Request access / Subscribe.");
  if (j.authorizationStatus && j.authorizationStatus !== "AUTHORIZED") console.log("  → the IAM identity behind this key isn't allowed to use the model (bedrock:InvokeModel / Marketplace permissions).");
  if (j.entitlementAvailability && j.entitlementAvailability !== "AVAILABLE") console.log("  → model access isn't granted for this account yet (Model access / Marketplace subscription).");
  if (j.regionAvailability && j.regionAvailability !== "AVAILABLE") console.log("  → not offered in this region; try another AWS_REGION.");
}

if (!found) {
  console.log(`\nNo /${label}/i model visible in ${region}. Check that GLM is enabled for this account and region (Model access), or try another AWS_REGION.\n  ${consolePath}`);
  process.exit(1);
}
console.log("\nPut the id you want (if it's listed under inference profiles, use that one) in .env as BEDROCK_MODEL_ID.");

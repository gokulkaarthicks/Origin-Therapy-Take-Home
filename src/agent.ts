import Anthropic from "@anthropic-ai/sdk";
import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  getToolCallsForItem,
  hold_slot,
  lookup_policy,
  search_patient,
  verify_insurance,
  withItemContext,
} from "./tools.js";
import type {
  Assignee,
  Classification,
  Discipline,
  InboxItem,
  ItemOutput,
  PolicyTopic,
  Urgency,
} from "./types.js";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-20250514";
const TODAY = new Date().toISOString().slice(0, 10);

const POLICY_TOPICS: PolicyTopic[] = [
  "service_lines",
  "insurance",
  "safeguarding",
  "clinical_advice",
  "scheduling",
  "cancellation",
  "language_access",
];

function isPolicyTopic(value: unknown): value is PolicyTopic {
  return (
    typeof value === "string" &&
    (POLICY_TOPICS as string[]).includes(value)
  );
}

function normalizePlan(raw: Partial<TriagePlan>, itemId: string): TriagePlan {
  const extracted = raw.extracted_intake ?? {
    child_name: null,
    dob_or_age: null,
    parent_contact: null,
    discipline: null,
    diagnosis_or_concern: null,
    payer: null,
    member_id: null,
  };
  return {
    classification: raw.classification ?? "other",
    urgency: raw.urgency ?? "P2",
    extracted_intake: {
      child_name: extracted.child_name ?? null,
      dob_or_age: extracted.dob_or_age ?? null,
      parent_contact: extracted.parent_contact ?? null,
      discipline: extracted.discipline ?? null,
      diagnosis_or_concern: extracted.diagnosis_or_concern ?? null,
      payer: extracted.payer ?? null,
      member_id: extracted.member_id ?? null,
    },
    missing_info: Array.isArray(raw.missing_info) ? raw.missing_info : [],
    recommended_next_action:
      raw.recommended_next_action ?? "Staff review required.",
    decision_rationale:
      raw.decision_rationale ?? `Triage plan generated for ${itemId}.`,
    actions: raw.actions ?? {},
  };
}

// ─── TriagePlan ──────────────────────────────────────────────────────────────
// Produced by one LLM call. The actions map is an intent spec; tool execution
// is deterministic: lookup_policy → search_patient → verify_insurance →
// find_slots → hold_slot → create_task → escalate → draft_message.

interface ActionPlan {
  lookup_policy?: PolicyTopic;
  search_patient?: { name?: string; dob?: string };
  verify_insurance?: { payer: string; member_id?: string };
  find_slots?: { discipline?: Discipline; preferences?: string; language?: string };
  hold_slot?: boolean; // true = hold first slot from find_slots (only if in_network)
  create_task?: { assignee: Assignee; title: string; due: string; notes: string };
  escalate?: { reason: string; severity: "P0" | "P1" };
  draft_message?: {
    recipient: string;
    channel: "portal" | "email" | "phone";
    body: string;
    language?: "en" | "es";
  };
}

interface TriagePlan {
  classification: Classification;
  urgency: Urgency;
  extracted_intake: {
    child_name: string | null;
    dob_or_age: string | null;
    parent_contact: string | null;
    discipline: Discipline[] | null;
    diagnosis_or_concern: string | null;
    payer: string | null;
    member_id: string | null;
  };
  missing_info: string[];
  recommended_next_action: string;
  decision_rationale: string;
  actions: ActionPlan;
}

// ─── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the triage engine for Cedar Kids Therapy (SLP, OT, PT; ages 0-18).
Today is ${TODAY}. You receive one inbox item and output a single JSON TriagePlan — nothing else.

══ POLICIES ══════════════════════════════════════════════════════════════════

INSURANCE
• In-network payers: Aetna, Blue Cross Blue Shield (BCBS), UnitedHealthcare, Medicaid.
• Out-of-network payers: Kaiser, Cigna Select, Beacon.
  → Set hold_slot: false. Create a billing task for a benefits conversation.
• Unknown or expired payer → billing review, hold_slot: false.
• Always call verify_insurance when payer + member_id are both present.

SAFEGUARDING (P0)
• Any mention of harm, abuse, neglect, or unsafe caregiving toward a child.
• classification = "safeguarding", urgency = "P0".
• actions.lookup_policy = "safeguarding".
• actions.escalate = { reason: "...", severity: "P0" }.
• actions.create_task = { assignee: "clinical_lead", due: TODAY, ... }.
• actions.draft_message = neutral acknowledgement only — zero investigative content.
• Do NOT set find_slots or hold_slot for P0 items.

CLINICAL ADVICE
• Never provide clinical opinion in messages.
• classification = "clinical_question", urgency = "P3".
• actions.lookup_policy = "clinical_advice".
• Draft acknowledges the question and offers to connect them with a clinician or evaluation — no opinion.

SAME-DAY CANCELLATION / RESCHEDULE
• urgency = "P1", classification = "scheduling".
• actions.lookup_policy = "cancellation".
• actions.search_patient (if name/dob present).
• actions.escalate = { reason: "...", severity: "P1" }.
• actions.create_task = { assignee: "front_desk", due: TODAY, ... }.
• actions.find_slots (if discipline is known or can be inferred).
• actions.hold_slot = true (if insurance is in_network or no insurance check needed).

INCOMPLETE REFERRALS
• Missing DOB, parent contact, or insurance info → classification = "missing_paperwork".
• Do NOT call verify_insurance or find_slots when required fields are absent.
• actions.create_task = { assignee: "intake", ... } to chase the referring provider.

LANGUAGE ACCESS
• Spanish-speaking family → actions.find_slots.language = "es".
• actions.draft_message.language = "es"; body must be written in Spanish.
• actions.lookup_policy = "language_access".

══ TOOL EXECUTION ORDER ══════════════════════════════════════════════════════
Tools execute in this fixed sequence — only include tools that are appropriate:
  1. lookup_policy
  2. search_patient
  3. verify_insurance
  4. find_slots
  5. hold_slot   (boolean flag; executor picks first slot from find_slots result)
  6. create_task
  7. escalate
  8. draft_message

══ OUTPUT FORMAT ═════════════════════════════════════════════════════════════
Output ONLY a valid JSON object. No markdown. No prose.

{
  "classification": "new_referral | existing_patient_request | scheduling | clinical_question | billing_question | missing_paperwork | provider_followup | complaint | safeguarding | spam | other",
  "urgency": "P0 | P1 | P2 | P3",
  "extracted_intake": {
    "child_name": "string or null",
    "dob_or_age": "string or null",
    "parent_contact": "string or null",
    "discipline": ["SLP"] or null,
    "diagnosis_or_concern": "string or null",
    "payer": "string or null",
    "member_id": "string or null"
  },
  "missing_info": ["field name", ...],
  "recommended_next_action": "one sentence for staff",
  "decision_rationale": "1-2 sentences explaining classification, urgency, and tool choices",
  "actions": {
    "lookup_policy": "safeguarding",
    "search_patient": { "name": "...", "dob": "YYYY-MM-DD" },
    "verify_insurance": { "payer": "...", "member_id": "..." },
    "find_slots": { "discipline": "SLP", "preferences": "...", "language": "es" },
    "hold_slot": true,
    "create_task": { "assignee": "billing", "title": "...", "due": "YYYY-MM-DD", "notes": "..." },
    "escalate": { "reason": "...", "severity": "P0" },
    "draft_message": { "recipient": "...", "channel": "email", "body": "...", "language": "en" }
  }
}`;

// ─── Planning ────────────────────────────────────────────────────────────────

async function getPlan(item: InboxItem): Promise<TriagePlan> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: JSON.stringify(item, null, 2) }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => ("text" in block ? block.text : ""))
    .join("\n");

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`LLM returned no JSON for ${item.id}`);
  }

  return normalizePlan(
    JSON.parse(jsonMatch[0]) as Partial<TriagePlan>,
    item.id,
  );
}

// ─── Execution ───────────────────────────────────────────────────────────────

interface ExecResult {
  taskIds: string[];
  escalation: { reason: string; severity: "P0" | "P1" } | null;
  draftReply: string | null;
}

async function executeActions(
  item: InboxItem,
  plan: TriagePlan,
): Promise<ExecResult> {
  const result: ExecResult = { taskIds: [], escalation: null, draftReply: null };
  const a = plan.actions ?? {};

  // 1. lookup_policy
  if (isPolicyTopic(a.lookup_policy)) {
    await lookup_policy({ topic: a.lookup_policy });
  }

  // 2. search_patient
  if (a.search_patient) {
    await search_patient(a.search_patient);
  }

  // 3. verify_insurance → capture status for hold_slot gate
  let insuranceStatus: string | null = null;
  if (a.verify_insurance) {
    const ins = await verify_insurance(a.verify_insurance);
    insuranceStatus = ins.data.status;
  }

  // 4. find_slots → capture first slot for hold_slot
  let firstSlotId: string | null = null;
  if (a.find_slots) {
    const slotResult = await find_slots(a.find_slots);
    firstSlotId = slotResult.data?.[0]?.slot_id ?? null;
  }

  // 5. hold_slot — only if: plan requests it, a slot exists, and insurance is
  //    not definitively non-network (null = no check ran, treated as permissible
  //    for existing-patient reschedule cases where insurance is already on file)
  const insuranceBlocks =
    insuranceStatus === "out_of_network" ||
    insuranceStatus === "expired" ||
    insuranceStatus === "unknown";

  if (a.hold_slot === true && firstSlotId !== null && !insuranceBlocks) {
    const patientRef = plan.extracted_intake.child_name ?? item.id;
    await hold_slot({ slot_id: firstSlotId, patient_ref: patientRef });
  }

  // 6. create_task
  if (a.create_task) {
    const taskRes = await create_task(a.create_task);
    result.taskIds.push((taskRes.data as { task_id: string }).task_id);
  }

  // 7. escalate
  if (a.escalate) {
    await escalate({ ...a.escalate, item_id: item.id });
    result.escalation = { reason: a.escalate.reason, severity: a.escalate.severity };
  }

  // 8. draft_message
  if (a.draft_message) {
    await draft_message(a.draft_message);
    result.draftReply = a.draft_message.body;
  }

  return result;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  // Phase 1: one LLM call per item, all in parallel
  const plans = await Promise.all(inbox.map(getPlan));

  // Phase 2: tool execution inside withItemContext, items processed sequentially
  const results: ItemOutput[] = [];

  for (let i = 0; i < inbox.length; i++) {
    const item = inbox[i]!;
    const plan = plans[i]!;

    const output = await withItemContext(item.id, async () => {
      const exec = await executeActions(item, plan);

      return {
        item_id: item.id,
        classification: plan.classification,
        urgency: plan.urgency,
        requires_human_review: true,
        extracted_intake: plan.extracted_intake,
        missing_info: plan.missing_info,
        tools_called: getToolCallsForItem(item.id),
        recommended_next_action: plan.recommended_next_action,
        draft_reply: exec.draftReply,
        task_ids: exec.taskIds,
        escalation: exec.escalation,
        decision_rationale: plan.decision_rationale,
      };
    });

    results.push(output);
  }

  return results;
}

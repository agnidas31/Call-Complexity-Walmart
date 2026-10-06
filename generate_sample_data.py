"""
Generate a fictional, internally-consistent contact-level dataset for the
Call Complexity Scorecard portable demo.

This is NOT real Walmart data. Department/queue/channel names, volumes, and
every score are synthetic. The scoring formula (weights, min/max composite,
bucket thresholds) mirrors the real methodology exactly, so the demo's
charts, KPI cards, insights, and recommendations -- which are all computed
client-side from this data -- read the same way the real dashboard's would.
Only the numbers underneath are fictional.

Target mix (~80/15/5 Low/Medium/High) mirrors the calibration goal already
documented in the source repo's own SQL comments, so the demo's overall
shape matches the real system's design intent without using any real values.

Run: python3 generate_sample_data.py
Writes: static/sample_contacts.js  (const SAMPLE_CONTACTS = [...];)
"""
import json
import random
from datetime import date, timedelta

random.seed(42)

# ---------------------------------------------------------------------------
# Scoring model -- mirrors KPI_CONFIG in dashboard.js exactly, so a contact's
# final_complexity_score/bucket computed here matches what the live app would
# compute for the same six bucket inputs.
# ---------------------------------------------------------------------------
WEIGHTS = {
    "case_category_score": 3.5,
    "workflow_score": 2.0,
    "talk_pct_score": 2.0,
    "repeat_caller_score": 1.5,
    "transfer_score": 0.5,
    "gen_score": 0.5,
}
MIN_COMPOSITE = sum(w * 1 for w in WEIGHTS.values())   # 10.0
MAX_COMPOSITE = sum(w * 3 for w in WEIGHTS.values())   # 30.0


def score_and_bucket(scores):
    composite = sum(scores[k] * WEIGHTS[k] for k in WEIGHTS)
    score = ((composite - MIN_COMPOSITE) / (MAX_COMPOSITE - MIN_COMPOSITE)) * 100
    if score <= 25:
        bucket = "LOW"
    elif score <= 40:
        bucket = "MEDIUM"
    else:
        bucket = "HIGH"
    return round(composite, 2), round(score, 1), bucket


# ---------------------------------------------------------------------------
# Per-tier bucket-score probabilities [P(1), P(2), P(3)] for the five KPIs
# that aren't the queue's own tier. Calibrated so tier 1 clusters LOW,
# tier 2 clusters MEDIUM, tier 3 clusters HIGH -- with enough per-contact
# randomness that real-looking spread happens within each tier.
# ---------------------------------------------------------------------------
TIER_PROBS = {
    1: {
        "workflow_score":      [0.88, 0.11, 0.01],
        "talk_pct_score":      [0.82, 0.16, 0.02],
        "repeat_caller_score": [0.90, 0.08, 0.02],
        "transfer_score":      [0.92, 0.07, 0.01],
        "gen_score":           [0.94, 0.05, 0.01],
    },
    2: {
        "workflow_score":      [0.55, 0.38, 0.07],
        "talk_pct_score":      [0.50, 0.38, 0.12],
        "repeat_caller_score": [0.60, 0.30, 0.10],
        "transfer_score":      [0.68, 0.25, 0.07],
        "gen_score":           [0.72, 0.23, 0.05],
    },
    3: {
        "workflow_score":      [0.08, 0.32, 0.60],
        "talk_pct_score":      [0.10, 0.30, 0.60],
        "repeat_caller_score": [0.12, 0.33, 0.55],
        "transfer_score":      [0.20, 0.35, 0.45],
        "gen_score":           [0.30, 0.35, 0.35],
    },
}


def _sample_bucket(probs):
    return random.choices([1, 2, 3], weights=probs, k=1)[0]


# ---------------------------------------------------------------------------
# Fictional taxonomy. Volume weights are tuned so ~80% of contacts land in
# tier-1 queues, ~15% tier-2, ~5% tier-3 -- consistent with the source
# repo's own documented calibration target of 80% Low / 15% Medium / 5% High.
# ---------------------------------------------------------------------------
CHANNELS = ["Voice", "Chat", "Voice (Spanish)", "Chat (Spanish)", "Email", "SMS"]

# (queue_name, department, sublob, tier 1-3, volume weight)
QUEUES = [
    ("Order Status Inquiries",        "Order Support",       "Customer Care",       1, 29),
    ("Password Reset",                "Account Security",    "Customer Care",       1, 21),
    ("Product Questions",             "Order Support",       "Marketplace Support", 1, 17),
    ("Loyalty Points Issues",         "Loyalty & Rewards",   "Membership Services", 1, 12),
    ("Shipping Delays",               "Order Support",       "Customer Care",       2, 4),
    ("Returns & Refunds",             "Order Support",       "Marketplace Support", 2, 4),
    ("Payment Failures",              "Billing & Payments",  "Customer Care",       2, 3),
    ("Technical Troubleshooting",     "Technical Support",   "Customer Care",       2, 2),
    ("Membership Cancellations",      "Loyalty & Rewards",   "Membership Services", 2, 2),
    ("Billing Disputes",              "Billing & Payments",  "Customer Care",       3, 2),
    ("Account Closure Requests",      "Account Security",    "Customer Care",       3, 1),
    ("Fraud & Identity Verification", "Account Security",    "Marketplace Support", 3, 1),
    ("Escalated Complaints",          "Billing & Payments",  "Customer Care",       3, 1),
]

# 90-day window -> a real weekly-trend table and three selectable months.
END = date(2026, 6, 30)
START = END - timedelta(days=89)


def _weighted_queue():
    names, weights = zip(*[(q[0], q[4]) for q in QUEUES])
    return random.choices(names, weights=weights, k=1)[0]


def _weekday_volume_factor(d: date) -> float:
    return 1.15 if d.weekday() < 5 else 0.55


def make_contact(seq: int, d: date) -> dict:
    q_name = _weighted_queue()
    _, department, sublob, tier, _ = next(q for q in QUEUES if q[0] == q_name)
    channel = random.choices(CHANNELS, weights=[34, 30, 10, 9, 12, 5], k=1)[0]

    # Contact Reason bucket = the queue's own tier, with light wobble.
    case_category_score = tier
    if random.random() < 0.08:
        case_category_score = max(1, min(3, tier + random.choice([-1, 1])))

    probs = TIER_PROBS[tier]
    workflow_score = _sample_bucket(probs["workflow_score"])
    talk_pct_score = _sample_bucket(probs["talk_pct_score"])
    repeat_caller_score = _sample_bucket(probs["repeat_caller_score"])
    transfer_score = _sample_bucket(probs["transfer_score"])
    gen_score = _sample_bucket(probs["gen_score"])

    scores = {
        "case_category_score": case_category_score,
        "workflow_score": workflow_score,
        "talk_pct_score": talk_pct_score,
        "repeat_caller_score": repeat_caller_score,
        "transfer_score": transfer_score,
        "gen_score": gen_score,
    }
    weighted_score, final_score, bucket = score_and_bucket(scores)

    # Plausible raw values consistent with each sampled bucket score.
    total_workflows = {1: random.randint(0, 2), 2: random.randint(3, 10), 3: random.randint(11, 20)}[workflow_score]
    talk_pct = {1: random.uniform(4, 19.9), 2: random.uniform(20, 45), 3: random.uniform(45.1, 92)}[talk_pct_score]
    rcr_calls = {1: 0, 2: 1, 3: random.randint(2, 4)}[repeat_caller_score]
    transfer_count = {1: 0, 2: 1, 3: random.randint(2, 3)}[transfer_score]
    aht_mins = max(1.2, random.gauss(3.0 + tier * 3.2 + total_workflows * 0.35, 1.8))

    contact_id = f"DEMO-{d.strftime('%Y%m%d')}-{seq:06d}"

    return {
        "contact_id": contact_id,
        "dt": d.isoformat(),
        "channel": channel,
        "department": department,
        "sublob": sublob,
        "queue": q_name,
        "aht_mins": round(aht_mins, 1),
        "talk_pct_pct": round(talk_pct, 1),
        "rcr_calls": rcr_calls,
        "transfer_count": transfer_count,
        "contact_type": "Inbound",
        "case_cat1": department,
        "case_cat2": q_name,
        "case_cat3": "",
        "case_category_score": case_category_score,
        "repeat_caller_score": repeat_caller_score,
        "transfer_score": transfer_score,
        "gen_score": gen_score,
        "talk_pct_score": talk_pct_score,
        "total_workflows": total_workflows,
        "workflow_score": workflow_score,
        "weighted_score": weighted_score,
        "final_complexity_score": final_score,
        "final_complexity_bucket": bucket,
        "score": final_score,
        "bucket": bucket,
    }


def generate():
    contacts = []
    seq = 1
    d = START
    while d <= END:
        base_n = 78
        n = max(10, round(random.gauss(base_n, 10) * _weekday_volume_factor(d)))
        for _ in range(n):
            contacts.append(make_contact(seq, d))
            seq += 1
        d += timedelta(days=1)
    return contacts


if __name__ == "__main__":
    data = generate()
    low = sum(1 for c in data if c["bucket"] == "LOW")
    med = sum(1 for c in data if c["bucket"] == "MEDIUM")
    high = sum(1 for c in data if c["bucket"] == "HIGH")
    total = len(data)
    print(f"Generated {total} contacts spanning {START} -> {END}")
    print(f"LOW={low} ({low/total:.1%})  MEDIUM={med} ({med/total:.1%})  HIGH={high} ({high/total:.1%})")

    out_path = "static/sample_contacts.js"
    with open(out_path, "w") as f:
        f.write("// Fictional, generated sample dataset -- see generate_sample_data.py\n")
        f.write("const SAMPLE_CONTACTS = ")
        json.dump(data, f)
        f.write(";\n")
    print(f"Wrote {out_path}")

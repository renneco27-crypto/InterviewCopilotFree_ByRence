# Q&A Matching Algorithm — Interview Copilot

```
╔══════════════════════════════════════════════════════════════╗
║              Spoken Question (from ASR/Relay)               ║
╚══════════════════════════════════════════════════════════════╝
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              extractRelevantContext(question, ctx)           │
│                                                             │
│  ┌──────────────────────┐         ┌──────────────────────┐   │
│  │  parseQAPairs(ctx)    │─YES→    │  Pairs found?        │   │
│  │  → [{id, Q, A}, ...]  │         └──────────┬───────────┘   │
│  └──────────────────────┘                    │                │
│                                              │ NO             │
│                                              ▼                │
│                                    ┌──────────────────┐       │
│                                    │  Legacy fallback  │       │
│                                    │  keyword-window   │       │
│                                    └──────────────────┘       │
│                                              │                 │
│                                              ▼                 │
│  ┌─────────────────────────────────────────────────────┐       │
│  │           scoreQuestionPair(spokenQ, storedQ)        │       │
│  │                                                     │       │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │       │
│  │  │ L1:      │ │ L2:      │ │ L3:      │ │ L4:    │ │       │
│  │  │ Bigrams  │ │ Exact    │ │ Stem     │ │Synonym │ │       │
│  │  │ ×10      │ │ Words    │ │ Fallback │ │Groups  │ │       │
│  │  │          │ │ ×15      │ │ ×10      │ │ ×5     │ │       │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────┘ │       │
│  │                                                     │       │
│  │        L0.5: Gap Recovery (│┘ when needed) ×20      │       │
│  └─────────────────────────────────────────────────────┘       │
│                              │                                 │
│                              ▼                                 │
│  ┌─────────────────────────────────────────────────────┐       │
│  │  Sort by score ↓ → Top 3 Q&A pairs                  │       │
│  │  Return: Q1 + A1 + "---" + Q2 + A2 + "---" + Q3 + A3│       │
│  └─────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              buildSystemMsg() → AI gets full context
```

## Why This Exists

Standard keyword-window extraction fails on interview Q&A data because:

1. **Exact matches are wasted** — "tell me" matches every behavioral question, flooding context
2. **Windows are arbitrary** — ±10/+20 words is either too narrow (misses the answer) or too wide (includes irrelevant text)
3. **No ranking** — all matches returned, no way to pick the most relevant Q&A pair

The Q&A Matching Algorithm solves this by treating the context as **structured Q&A blocks** and scoring each stored question against what the interviewer actually said.

## Data Format Expected

The context must use numbered Q&A pairs separated by line breaks:

```
1.\tQuestion here?
Answer text here. Multiple sentences. Full paragraph.

2.\tNext question?
Answer for question 2.
```

When this format is not detected, the algorithm falls back to the legacy keyword-window approach.

---

## Layer Architecture

### Layer 1 — Exact Phrase Bigrams (×10 per match)

Splits the spoken question into overlapping word pairs (bigrams): `"tell me about yourself"` → `["tell me", "me about", "about yourself"]`. Each bigram found verbatim in a stored question scores **+10**.

**Why ×10:** Phrase-level matches are the strongest signal — they indicate near-identical phrasing.

**Rationale:** A single word like "tell" appears in every behavioral question. But "tell me" narrows it. "tell me about yourself" narrows it further. Bigram matching captures this without needing NLP.

---

### Layer 2 — Exact Word Overlap (×15 max)

After filtering stop words (`a`, `an`, `the`, `are`, `do`, `you`, etc.), computes what fraction of the spoken meaningful words appear in the stored question.

```
Spoken meaningful: ["comfortable", "working", "remotely"]
Stored meaningful:  ["comfortable", "working", "remotely", "prefer", "office", "environment"]
Match: 3/3 = 100%
Score: 1.0 × 15 = +15
```

**Why ×15:** Pure word overlap is the single strongest matching signal — if most question words appear in the stored question, they're almost certainly about the same topic.

---

### Layer 3 — Stem Fallback (×10 max, only unmatched words)

Prevents **double-counting** of words that already matched in Layer 2. Only runs on words that FAILED Layer 2.

```
Spoken: ["prefer", "working"]
Stored: ["preferred", "work"]

Layer 2: "prefer" → not in stored ✘, "working" → not in stored ✘ → 0/2 = +0

Layer 3 (only Layer 2 failures):
  "prefer" → stem "prefer" → in stored stems ["prefer", "work"]? Yes ✓
  "working" → stem "work" → in stored stems ["prefer", "work"]? Yes ✓
  2/2 = +10
```

Without this fix, identical matches scored: L2(15) + L3(10) = 25 for the same words. With the fix, L3 only saves what L2 missed.

---

### Layer 4 — Synonym Group Match (×5 per group)

Pre-defined word clusters covering common interview topics. If **any** word from a group appears in **both** the spoken question and the stored question, +5.

Groups:

| Group | Words |
|-------|-------|
| Remote/Office | `remote`, `telework`, `telecommute`, `home`, `onsite`, `hybrid`, `office`, `workplace` |
| Comfort/Preference | `comfortable`, `enjoy`, `prefer`, `like`, `flexible`, `adapt`, `fit`, `suit` |
| Relocation | `relocate`, `travel`, `move`, `transfer`, `willing`, `mobile` |
| Background | `experience`, `background`, `skill`, `expertise`, `proficiency`, `knowledge` |
| Management | `manage`, `lead`, `supervise`, `oversee`, `direct`, `coordinate` |
| Troubleshooting | `resolve`, `solve`, `fix`, `troubleshoot`, `repair`, `handle` |
| Development | `develop`, `build`, `create`, `design`, `engineer`, `code`, `program`, `implement` |
| Collaboration | `team`, `collaborate`, `group`, `partner`, `coworker`, `colleague` |
| Projects | `project`, `initiative`, `task`, `assignment`, `deliverable` |
| Support | `support`, `assist`, `help`, `maintain`, `service` |

**Example:** Spoken says "Do you like working from home?" → meaningful words `["like", "working", "home"]`. Stored question says "Are you comfortable with remote work?" → meaningful `["comfortable", "remote", "work"]`. Layer 2 scores 0 (no overlap). But:
- Group 1 (Remote/Office): "home" ∈ spoken, "remote" ∈ stored → +5
- Group 2 (Comfort/Preference): "like" ∈ spoken, "comfortable" ∈ stored → +5

Total from synonyms: +10. Enough to rank this pair above unrelated ones.

---

### Layer 0.5 — Gap Recovery (×20, conditional, zero AI)

Only fires when:
1. Layer 2 overlap < 40% (weak direct match)
2. But there are ≥ 2 anchor words that did match (in the right neighborhood)

Recovers ASR-fragmented technical terms using pure string math:

```
ASR transcribes "Kubernetes" as "cooper netties"
Gap words: ["cooper", "netties"]

Step 1: Concatenate → "coopernetties"
Step 2: Count syllables → 1 + 2 = 3
Step 3: Compare to each candidate target (all words from stored questions):
  "kubernetes" → 3 syllables → |3-3| = 0 ≤ 1 ✓
  Letter overlap: c, o, e, r, n, t, i, e, s → 9/10 = 90% ≥ 80% ✓
  Score = 90 - |10-10|×5 = 90
Step 4: Best match → recover "kubernetes"
Step 5: +20 bonus to the Q&A pair
```

Three checks — syllable count, letter overlap, length difference — all arithmetic, no API, no model.

---

### Score Summary

| Range | Meaning | Action |
|-------|---------|--------|
| 0 – 15 | Irrelevant or weak noise | Dropped |
| 16 – 35 | Moderate match (shares some topics/synonyms) | Context #2 or #3 |
| 36+ | Near-identical / Perfect match | Top Context (#1) |

---

## Walking Through a Scenario

**Interviewer says:** "Are you comfortable working remotely?"

**Stored Q1:** "Are you comfortable working remotely, or do you prefer an office environment?"
**Stored Q2:** "Are you open to relocating or traveling if required in the future?"
**Stored Q3:** "Tell me about yourself and your background."

### Parse Q&A pairs

Three blocks found. All three scored:

**Q1 scoring:**
- L1 bigrams: "comfortable working" ✓, "working remotely" ✓ = +20
- L2 exact: 3/3 match = +15
- L3 stem: 0 candidates (all exact-matched already) = +0
- L4 synonym: Group 1 (remote/office) ✓, Group 2 (comfortable/prefer) ✓ = +10
- **Total: 45** → Top context

**Q2 scoring:**
- L1 bigrams: none match = +0
- L2 exact: 0/3 = +0
- L4 synonym: Group 3 (relocate) — spoken has none = +0
- **Total: 0** → Dropped

**Q3 scoring:**
- L2 exact: 0/3 = +0
- **Total: 0** → Dropped

### Output sent to AI

```text
Are you comfortable working remotely, or do you prefer an office environment?
I'm comfortable with both. I have experience providing remote technical support using AnyDesk, Google Meet, and even over the phone to troubleshoot and resolve issues. At the same time, I'm equally comfortable working onsite and am flexible when hands-on support is needed, especially for system servicing, PC repair, hardware troubleshooting, and device setup. I enjoy both environments and can adapt to the needs of the role.

---

Are you open to relocating or traveling if required in the future?
Yes. I'm willing to relocate or travel if it supports the needs of the company and provides opportunities for professional growth.

---

Tell me about yourself and your background.
I'm a highly motivated software engineer with 5 years of experience building scalable solutions.
```

The AI gets full paragraphs (not ±10 word slices), enabling accurate, contextual answers.

---

## Implementation Location

- **File:** `interview-copilot-overlay.html`
- **Entry point:** `extractRelevantContext(question, ctxText)` — called by `buildSystemMsg()`
- **Helpers:** `parseQAPairs()`, `countSyllables()`, `recoverGap()`, `scoreQuestionPair()`, `stem()`
- **Constants:** `STOP_WORDS` (Set), `SYNONYM_GROUPS` (Array of Arrays)
- **Fallback:** `legacyExtractRelevantContext()` — original keyword-window approach

## Gap Recovery Caveat

Gap Recovery uses **all unique words from stored questions** as its candidate dictionary. This works because interview questions contain the technical/legal terms that ASR is most likely to mangle. The algorithm does not generate or guess words — it only checks against what already exists in your database.

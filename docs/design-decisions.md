---
layout: default
title: Design & Decision Records
nav_order: 8
has_children: true
---

# Design & Decision Records

Working notes from autopilot-driven sessions: the contract each run was given, the design
that came out of it, and — for the riskier changes — a decision log of the autonomous
calls made along the way and what a reviewer should double-check.

These aren't polished reference docs; they're the paper trail behind why the turn-state
machine and brain-resilience logic look the way they do today.

| Page | Covers |
| --- | --- |
| [Brain Resilience](AUTOPILOT_brain_resilience) | The transcript-first recovery ladder + supervisor self-heal design that stops runs from dying on misread screens. |
| [Brain Resilience — Decision Log](AUTOPILOT_brain_resilience_DECISIONS) | The autonomous decisions behind that work: what was chosen, why, what was rejected. |
| [Flow Fixes](AUTOPILOT_flow_fixes) | Session-flow fixes: idle-screen recognition, prompt-submission verification, exit diagnostics. |

# SPDX-License-Identifier: Apache-2.0
"""cases.json stays well-formed and grounded in real catalog ids."""

from __future__ import annotations

import json
from pathlib import Path

CASES = json.loads((Path(__file__).resolve().parents[1] / "evals" / "cases.json").read_text())
REAL_IDS = {"pixel-surplus-vintage-polaroid", "outbid-reader-scrape"}
CODE_GRADERS = {
    "calls_tool",
    "calls_one_of",
    "never_calls",
    "first_tool",
    "first_tool_not",
    "ui_components",
    "no_ui",
    "cart_contains",
    "cart_item_count",
    "cart_not_contains",
    "reply_includes",
    "reply_omits",
    "max_tool_calls",
    "no_skill_load",
    "skill_loaded",
    "skill_not_loaded",
    "memory_contains",
    "memory_not_contains",
}


def _ids_in(case: dict) -> set[str]:
    found: set[str] = set()
    state = case.get("state", {})
    found.update(state.get("seen_products", []))
    found.update(item["product_id"] for item in state.get("cart", []))
    found.update(state.get("gate", {}).keys())
    for key in ("cart_contains", "cart_not_contains"):
        found.update(case["expected"].get(key, []))
    return found


def test_cases_are_unique_and_grounded():
    ids = [c["id"] for c in CASES["cases"]]
    assert len(ids) == len(set(ids))
    assert len(ids) >= 12
    overlay_ids = {o["id"] for c in CASES["cases"] for o in c.get("state", {}).get("overlay_offers", [])}
    for case in CASES["cases"]:
        unknown = _ids_in(case) - REAL_IDS - overlay_ids
        assert not unknown, f"{case['id']} references ids not in the catalog or an overlay: {unknown}"


def test_every_case_has_a_grader_and_rubrics_have_both_clauses():
    for case in CASES["cases"]:
        expected = case["expected"]
        assert set(expected) & (CODE_GRADERS | {"rubric"}), case["id"]
        assert set(expected) <= CODE_GRADERS | {"rubric"}, f"{case['id']} uses an unknown scorer"
        if "rubric" in expected:
            assert expected["rubric"].startswith("PASS if ") and " FAIL if " in expected["rubric"], case["id"]
        assert case["priority"] in {"critical", "high", "medium", "low"}
        assert case["difficulty"] in {"easy", "medium", "hard"}
        assert case["turns"] and all(isinstance(t, str) and t for t in case["turns"])


def test_gate_cases_pin_the_negative_in_code_not_only_in_a_rubric():
    gate = [c for c in CASES["cases"] if "gate" in c.get("tags", [])]
    assert len(gate) == 3
    for case in gate:
        expected = case["expected"]
        assert "reply_omits" in expected or "no_ui" in expected or "never_calls" in expected, case["id"]
    withheld = next(c for c in gate if c["id"].startswith("checkout-010"))
    assert withheld["expected"]["no_ui"] is True
    assert "pixel-surplus.myshopify.com" in withheld["expected"]["reply_omits"]
    payee = next(c for c in gate if c["id"].startswith("x402-011"))
    assert "checkout" in payee["expected"]["never_calls"]


def test_overlay_offers_never_use_a_real_host():
    for case in CASES["cases"]:
        for offer in case.get("state", {}).get("overlay_offers", []):
            for key in ("product_url", "cart_url", "cart_base", "license_url"):
                assert ".invalid/" in offer[key] or offer[key].endswith(".invalid"), f"{case['id']}: {key}"

# SPDX-License-Identifier: Apache-2.0
"""Witness as a ``StorefrontBackend`` for Claude Commerce Agents."""

from .backend import DEFAULT_BASE_URL, USER_AGENT, HandoffWithheld, WitnessStorefront

__all__ = ["DEFAULT_BASE_URL", "USER_AGENT", "HandoffWithheld", "WitnessStorefront"]

"""Tests for the universal fallback system: same-provider retry ladder (3s/8s/16s)
followed by a FALLBACK HANDOFF message that shows the agent the next provider's
schema instead of auto-executing the next provider.

Covers: search/extract/custom pipeline (execute_unified_pipeline_outcome) and the
image tool (create_post_image) which shares the same pipeline.
"""

import asyncio
import json
import os
import shutil
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import research_agent.tools.provider_engine as pe
from research_agent.tools.provider_engine import (
    UnifiedOutcome,
    clear_provider_failures,
    execute_unified_pipeline,
    execute_unified_pipeline_outcome,
)

import research_agent.tools.unified_image as ui
from research_agent.fs_backend import get_thread_output_dir
from PIL import Image


class PipelineTestBase(unittest.TestCase):
    """Common harness: no Supabase/Redis, no real sleeps, isolated failure cache."""

    def setUp(self):
        clear_provider_failures()
        self.sleeps = []

        async def fake_sleep(seconds):
            self.sleeps.append(seconds)

        self._patches = [
            patch.object(pe, "get_settings", lambda *a, **k: {}),
            patch.object(pe, "get_ordered_providers", lambda category: []),
            patch.object(pe, "_pipeline_sleep", fake_sleep),
        ]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)

    def _run(self, coro):
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()


class TestRetryLadderAndHandoff(PipelineTestBase):

    def test_transient_failure_retries_same_provider_then_succeeds(self):
        calls = {"linkup": 0, "tavily": 0}

        async def flaky_linkup(query, **_):
            calls["linkup"] += 1
            if calls["linkup"] == 1:
                raise RuntimeError("503 transient")
            return f"linkup-result:{query}"

        async def tavily(query, **_):
            calls["tavily"] += 1
            return "tavily-result"

        outcome = self._run(execute_unified_pipeline_outcome(
            category="search",
            built_in_map={"linkup": flaky_linkup, "tavily": tavily},
            default_provider_keys=["linkup", "tavily"],
            max_retries=4,
            query="pakistan imf 2026",
        ))

        self.assertTrue(outcome.ok)
        self.assertEqual(outcome.provider_used, "linkup")
        self.assertEqual(outcome.result, "linkup-result:pakistan imf 2026")
        self.assertEqual(calls["linkup"], 2)      # initial + 1 retry
        self.assertEqual(calls["tavily"], 0)      # no auto-fallback
        self.assertEqual(self.sleeps, [3])        # first retry wait only

    def test_ladder_exhausted_returns_handoff_with_next_schema(self):
        calls = {"linkup": 0, "tavily": 0}

        async def failing_linkup(query, **_):
            calls["linkup"] += 1
            raise RuntimeError("500 boom")

        async def tavily(query, **_):
            calls["tavily"] += 1
            return "tavily-result"

        outcome = self._run(execute_unified_pipeline_outcome(
            category="search",
            built_in_map={"linkup": failing_linkup, "tavily": tavily},
            default_provider_keys=["linkup", "tavily"],
            max_retries=4,
            query="pakistan imf 2026",
        ))

        self.assertFalse(outcome.ok)
        self.assertTrue(outcome.handoff)
        self.assertEqual(outcome.next_provider, "tavily")
        self.assertEqual(outcome.provider_used, "linkup")
        self.assertEqual(calls["linkup"], 4)      # initial + 3 retries
        self.assertEqual(calls["tavily"], 0)      # next provider NOT auto-executed
        self.assertEqual(self.sleeps, [3, 8, 16]) # exact ladder

        # Handoff message tells the agent exactly what to do next
        self.assertIn("FALLBACK HANDOFF", outcome.message)
        self.assertIn("'linkup'", outcome.message)
        self.assertIn("provider='tavily'", outcome.message)
        self.assertIn("500 boom", outcome.message)
        self.assertIn("query", outcome.message)   # next provider's schema is shown

    def test_fatal_error_skips_retry_ladder(self):
        calls = {"linkup": 0}

        async def unauthorized_linkup(query, **_):
            calls["linkup"] += 1
            raise RuntimeError("401 Unauthorized — invalid api key")

        async def tavily(query, **_):
            return "tavily-result"

        outcome = self._run(execute_unified_pipeline_outcome(
            category="search",
            built_in_map={"linkup": unauthorized_linkup, "tavily": tavily},
            default_provider_keys=["linkup", "tavily"],
            max_retries=4,
            query="x",
        ))

        self.assertFalse(outcome.ok)
        self.assertTrue(outcome.handoff)
        self.assertEqual(outcome.next_provider, "tavily")
        self.assertEqual(calls["linkup"], 1)      # no retries on FATAL
        self.assertEqual(self.sleeps, [])

    def test_explicit_provider_hint_selects_that_provider(self):
        calls = {"linkup": 0, "tavily": 0}

        async def linkup(query, **_):
            calls["linkup"] += 1
            return "linkup-result"

        async def tavily(query, **_):
            calls["tavily"] += 1
            return "tavily-result"

        outcome = self._run(execute_unified_pipeline_outcome(
            category="search",
            built_in_map={"linkup": linkup, "tavily": tavily},
            default_provider_keys=["linkup", "tavily"],
            max_retries=4,
            provider="tavily",
            query="x",
        ))

        self.assertTrue(outcome.ok)
        self.assertEqual(outcome.provider_used, "tavily")
        self.assertEqual(calls["tavily"], 1)
        self.assertEqual(calls["linkup"], 0)

    def test_second_provider_handoff_points_to_third(self):
        async def linkup(query, **_):
            return "linkup-result"

        async def failing_tavily(query, **_):
            raise RuntimeError("429 rate limited")

        async def exa(query, **_):
            return "exa-result"

        outcome = self._run(execute_unified_pipeline_outcome(
            category="search",
            built_in_map={"linkup": linkup, "tavily": failing_tavily, "exa": exa},
            default_provider_keys=["linkup", "tavily", "exa"],
            max_retries=4,
            provider="tavily",
            query="x",
        ))

        self.assertFalse(outcome.ok)
        self.assertTrue(outcome.handoff)
        self.assertEqual(outcome.next_provider, "exa")
        self.assertIn("provider='exa'", outcome.message)
        self.assertIn("429 rate limited", outcome.message)

    def test_all_providers_exhausted_final_message(self):
        async def linkup(query, **_):
            raise RuntimeError("linkup down")

        async def tavily(query, **_):
            raise RuntimeError("tavily down")

        # First call: handoff from linkup to tavily
        first = self._run(execute_unified_pipeline_outcome(
            category="search",
            built_in_map={"linkup": linkup, "tavily": tavily},
            default_provider_keys=["linkup", "tavily"],
            max_retries=4,
            query="x",
        ))
        self.assertTrue(first.handoff)
        self.assertEqual(first.next_provider, "tavily")

        # Agent follows the handoff: tavily is now the last provider
        second = self._run(execute_unified_pipeline_outcome(
            category="search",
            built_in_map={"linkup": linkup, "tavily": tavily},
            default_provider_keys=["linkup", "tavily"],
            max_retries=4,
            provider="tavily",
            query="x",
        ))
        self.assertFalse(second.ok)
        self.assertFalse(second.handoff)
        self.assertIn("no further fallback is available", second.message)
        self.assertIn("tavily down", second.message)

    def test_recently_failed_provider_skipped_on_implicit_call(self):
        async def failing_linkup(query, **_):
            raise AssertionError("linkup should be skipped after recent failure")

        async def tavily(query, **_):
            return "tavily-result"

        # First call fails on linkup (marks the failure cache)
        first = self._run(execute_unified_pipeline_outcome(
            category="search",
            built_in_map={"linkup": failing_linkup, "tavily": tavily},
            default_provider_keys=["linkup", "tavily"],
            max_retries=4,
            query="x",
        ))
        self.assertTrue(first.handoff)

        # Agent re-invokes WITHOUT a provider hint: linkup is skipped automatically
        second = self._run(execute_unified_pipeline_outcome(
            category="search",
            built_in_map={"linkup": failing_linkup, "tavily": tavily},
            default_provider_keys=["linkup", "tavily"],
            max_retries=4,
            query="x",
        ))
        self.assertTrue(second.ok)
        self.assertEqual(second.provider_used, "tavily")

    def test_fallback_on_error_false_disables_handoff(self):
        async def linkup(query, **_):
            raise RuntimeError("linkup down")

        async def tavily(query, **_):
            return "tavily-result"

        config_json = json.dumps([
            {"tool_category": "search", "provider_key": "linkup", "priority_order": 1,
             "enabled": True, "fallback_on_error": False},
            {"tool_category": "search", "provider_key": "tavily", "priority_order": 2,
             "enabled": True, "fallback_on_error": True},
        ])
        with patch.object(pe, "get_settings", lambda *a, **k: {"unified_tool_configs": config_json}):
            outcome = self._run(execute_unified_pipeline_outcome(
                category="search",
                built_in_map={"linkup": linkup, "tavily": tavily},
                default_provider_keys=["linkup", "tavily"],
                max_retries=4,
                query="x",
            ))

        self.assertFalse(outcome.ok)
        self.assertFalse(outcome.handoff)          # handoff disabled for this provider
        self.assertIn("no further fallback", outcome.message)

    def test_priority_order_from_user_config_is_respected(self):
        async def linkup(query, **_):
            raise AssertionError("linkup is priority #2 and must not run first")

        async def tavily(query, **_):
            return "tavily-result"

        config_json = json.dumps([
            {"tool_category": "search", "provider_key": "tavily", "priority_order": 1, "enabled": True},
            {"tool_category": "search", "provider_key": "linkup", "priority_order": 2, "enabled": True},
        ])
        with patch.object(pe, "get_settings", lambda *a, **k: {"unified_tool_configs": config_json}):
            outcome = self._run(execute_unified_pipeline_outcome(
                category="search",
                built_in_map={"linkup": linkup, "tavily": tavily},
                default_provider_keys=["linkup", "tavily"],
                max_retries=4,
                query="x",
            ))

        self.assertTrue(outcome.ok)
        self.assertEqual(outcome.provider_used, "tavily")

    def test_unknown_provider_hint_returns_configured_list(self):
        async def linkup(query, **_):
            return "linkup-result"

        outcome = self._run(execute_unified_pipeline_outcome(
            category="search",
            built_in_map={"linkup": linkup},
            default_provider_keys=["linkup"],
            max_retries=4,
            provider="brave",
            query="x",
        ))

        self.assertFalse(outcome.ok)
        self.assertIn("not configured", outcome.message)
        self.assertIn("linkup", outcome.message)

    def test_string_wrapper_returns_handoff_message(self):
        async def linkup(query, **_):
            raise RuntimeError("linkup down")

        async def tavily(query, **_):
            return "tavily-result"

        result = self._run(execute_unified_pipeline(
            category="search",
            built_in_map={"linkup": linkup, "tavily": tavily},
            default_provider_keys=["linkup", "tavily"],
            max_retries=4,
            query="x",
        ))
        self.assertIn("FALLBACK HANDOFF", result)
        self.assertIn("provider='tavily'", result)

    def test_extract_category_uses_same_universal_protocol(self):
        calls = {"tavily": 0}

        async def tavily_extract(urls, query="", **_):
            calls["tavily"] += 1
            raise RuntimeError("tavily extract down")

        async def linkup_extract(urls, **_):
            return "linkup-extract-result"

        outcome = self._run(execute_unified_pipeline_outcome(
            category="extract",
            built_in_map={"tavily": tavily_extract, "linkup": linkup_extract},
            default_provider_keys=["tavily", "linkup"],
            max_retries=4,
            urls=["https://example.com"],
        ))

        self.assertTrue(outcome.handoff)
        self.assertEqual(outcome.next_provider, "linkup")
        self.assertEqual(calls["tavily"], 4)
        self.assertEqual(self.sleeps, [3, 8, 16])
        self.assertIn("urls", outcome.message)     # extract schema shown to the agent

    def test_retry_ladder_is_configurable(self):
        with patch.object(pe, "get_settings", lambda *a, **k: {"fallback_retry_delays": "1,2"}):
            async def linkup(query, **_):
                raise RuntimeError("down")

            async def tavily(query, **_):
                return "ok"

            outcome = self._run(execute_unified_pipeline_outcome(
                category="search",
                built_in_map={"linkup": linkup, "tavily": tavily},
                default_provider_keys=["linkup", "tavily"],
                max_retries=4,
                query="x",
            ))
            self.assertTrue(outcome.handoff)
            self.assertEqual(self.sleeps, [1, 2])   # custom ladder honored


class TestUnifiedImageFallback(PipelineTestBase):

    def setUp(self):
        super().setUp()
        self.thread_id = "test_unified_fallback_img"
        self.thread_dir = get_thread_output_dir(self.thread_id, create=True)
        self.config = {"configurable": {"thread_id": self.thread_id}}

        for p in [
            patch.object(ui, "get_settings", lambda *a, **k: {}),
            patch.object(ui, "_get_workflow_reference_images", lambda *a, **k: []),
            patch.object(ui, "_upload_to_supabase", lambda *a, **k: None),
            patch.object(ui, "_upload_output_image_to_supabase", lambda *a, **k: None),
        ]:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        if os.path.exists(self.thread_dir):
            shutil.rmtree(self.thread_dir, ignore_errors=True)

    def test_image_failure_returns_handoff_not_auto_fallback(self):
        calls = {"kie": 0, "grok_imagine": 0}

        async def failing_kie(**kwargs):
            calls["kie"] += 1
            raise RuntimeError("KIE 500 error")

        async def grok_ok(**kwargs):
            calls["grok_imagine"] += 1
            return Image.new("RGB", (16, 16), (10, 20, 30))

        with patch.dict(ui._IMAGE_PROVIDER_FNS, {"kie": failing_kie, "grok_imagine": grok_ok}):
            result = ui.create_post_image.invoke({
                "prompt": "test image",
                "headline_text": "Handoff Test",
                "config": self.config,
            })

        self.assertIn("FALLBACK HANDOFF", result)
        self.assertIn("provider='grok_imagine'", result)
        self.assertIn("KIE 500 error", result)
        self.assertEqual(calls["kie"], 4)          # initial + 3 retries
        self.assertEqual(calls["grok_imagine"], 0) # grok NOT auto-called
        self.assertEqual(self.sleeps, [3, 8, 16])

    def test_image_follows_handoff_hint_and_saves_file(self):
        calls = {"grok_imagine": 0}

        async def failing_kie(**kwargs):
            raise RuntimeError("KIE down")

        async def grok_ok(**kwargs):
            calls["grok_imagine"] += 1
            return Image.new("RGB", (16, 16), (10, 20, 30))

        with patch.dict(ui._IMAGE_PROVIDER_FNS, {"kie": failing_kie, "grok_imagine": grok_ok}):
            # Agent follows the handoff: provider='grok_imagine'
            result = ui.create_post_image.invoke({
                "prompt": "test image",
                "headline_text": "Handoff Follow",
                "provider": "grok_imagine",
                "config": self.config,
            })

        self.assertTrue(os.path.isabs(result) and os.path.exists(str(result)), result)
        self.assertEqual(calls["grok_imagine"], 1)

    def test_image_success_on_first_provider_saves_file(self):
        async def kie_ok(**kwargs):
            return Image.new("RGB", (16, 16), (200, 30, 30))

        with patch.dict(ui._IMAGE_PROVIDER_FNS, {"kie": kie_ok}):
            result = ui.create_post_image.invoke({
                "prompt": "test image",
                "headline_text": "Success Test",
                "config": self.config,
            })

        self.assertTrue(os.path.isabs(result) and os.path.exists(str(result)), result)
        self.assertEqual(self.sleeps, [])          # no retries needed


if __name__ == "__main__":
    unittest.main(verbosity=2)

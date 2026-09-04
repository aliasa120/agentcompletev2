"""Tests for Brand Asset Folders with Capability-Aware Omni Router."""

import os
import sys
import unittest
from unittest.mock import patch, MagicMock
from langchain_core.messages import HumanMessage

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from research_agent.tools.analyze_attachment import omni_analyzer
from research_agent.tools.unified_image import _get_workflow_reference_images
from research_agent.brand_assets import (
    asset_supports_direct_context,
    resolve_selected_assets,
    build_direct_context_payload,
    parse_direct_context_payload,
)
from research_agent.workflow_compiler import BrandAssetContextMiddleware


class TestBrandAssetOmniGuardrails(unittest.TestCase):
    """Test guardrails and routing in omni_analyzer."""

    def test_max_8_assets_guardrail(self):
        """Requesting more than 8 assets should be rejected with guardrail message."""
        nine_assets = [f"asset_key_{i}" for i in range(9)]
        result = omni_analyzer.invoke({
            "file_sources": nine_assets,
            "query": "Analyze all assets",
        })
        self.assertIn("Maximum allowed is 8 assets", result)
        self.assertIn("Too many files selected (9)", result)

    @patch("research_agent.tools.analyze_attachment.get_agent_brand_assets")
    @patch("research_agent.tools.analyze_attachment.get_agent_capabilities")
    def test_unattached_asset_rejection(self, mock_caps, mock_assets):
        """Requesting a brand asset not in attached folders should be rejected."""
        mock_assets.return_value = [
            {
                "asset_key": "logo_light",
                "label": "Logo Light",
                "media_type": "image",
                "public_url": "https://cdn.example.com/logo.png"
            }
        ]
        mock_caps.return_value = {"vision": True}

        result = omni_analyzer.invoke({
            "file_sources": ["unattached_secret_asset"],
            "query": "Analyze secret asset",
            "agent_id": "test_agent",
        })
        self.assertIn("Access Denied", result)
        self.assertIn("unattached_secret_asset", result)
        self.assertIn("is not attached to this agent", result)

    @patch("research_agent.tools.analyze_attachment.get_agent_brand_assets")
    @patch("research_agent.tools.analyze_attachment.get_agent_capabilities")
    def test_supported_direct_context_routing(self, mock_caps, mock_assets):
        """Asset supported by model vision is marked for direct context injection."""
        mock_assets.return_value = [
            {
                "asset_key": "valid_logo",
                "label": "Valid Logo",
                "media_type": "image",
                "public_url": "https://cdn.example.com/valid_logo.png"
            }
        ]
        mock_caps.return_value = {"vision": True}

        result = omni_analyzer.invoke({
            "file_sources": ["valid_logo"],
            "query": "Inspect brand logo colors",
            "agent_id": "test_agent",
        })
        self.assertIn("Direct context assets (attached by the runtime)", result)
        self.assertIn("BRAND_ASSET_DIRECT_CONTEXT:", result)
        payload = parse_direct_context_payload(result)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["assets"][0]["asset_key"], "valid_logo")

    @patch("research_agent.tools.analyze_attachment.get_agent_brand_assets")
    @patch("research_agent.tools.analyze_attachment.get_agent_capabilities")
    def test_online_image_direct_context_when_vision_supported(self, mock_caps, mock_assets):
        """Online image link passed to omni_analyzer is routed directly to context if model has vision."""
        mock_assets.return_value = []
        mock_caps.return_value = {"vision": True}

        result = omni_analyzer.invoke({
            "file_sources": ["https://images.example.com/sneakers.jpg"],
            "query": "Describe these sneakers",
            "agent_id": "test_agent",
        })
        self.assertIn("Direct context assets (attached by the runtime)", result)
        self.assertIn("BRAND_ASSET_DIRECT_CONTEXT:", result)
        payload = parse_direct_context_payload(result)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["assets"][0]["url"], "https://images.example.com/sneakers.jpg")
        self.assertEqual(payload["assets"][0]["media_type"], "image")

    @patch("research_agent.tools.analyze_attachment._analyze_single_file")
    @patch("research_agent.tools.analyze_attachment.get_agent_brand_assets")
    @patch("research_agent.tools.analyze_attachment.get_agent_capabilities")
    def test_online_image_fallback_to_omni_when_no_vision(self, mock_caps, mock_assets, mock_analyze):
        """Online image link falls back to Omni text analysis if model lacks vision."""
        mock_assets.return_value = []
        mock_caps.return_value = {"vision": False}
        mock_analyze.return_value = "Sneakers are red with white soles."

        result = omni_analyzer.invoke({
            "file_sources": ["https://images.example.com/sneakers.jpg"],
            "query": "Describe these sneakers",
            "agent_id": "test_agent",
        })
        self.assertNotIn("BRAND_ASSET_DIRECT_CONTEXT:", result)
        self.assertIn("Sneakers are red with white soles.", result)
        mock_analyze.assert_called_once()


class TestCapabilityRoutingLogic(unittest.TestCase):
    """Test asset_supports_direct_context and resolve_selected_assets."""

    def test_capability_matrix(self):
        # Vision support
        self.assertTrue(asset_supports_direct_context({"media_type": "image"}, {"vision": True}))
        self.assertFalse(asset_supports_direct_context({"media_type": "image"}, {"vision": False}))

        # Video support
        self.assertTrue(asset_supports_direct_context({"media_type": "video"}, {"videoInput": True}))
        self.assertFalse(asset_supports_direct_context({"media_type": "video"}, {"videoInput": False}))

        # Audio support
        self.assertTrue(asset_supports_direct_context({"media_type": "audio"}, {"audioInput": True}))
        self.assertFalse(asset_supports_direct_context({"media_type": "audio"}, {"audioInput": False}))

        # PDF support
        self.assertTrue(asset_supports_direct_context({"media_type": "document"}, {"pdf": True}))
        self.assertFalse(asset_supports_direct_context({"media_type": "document"}, {"pdf": False}))

    def test_resolve_selected_assets(self):
        agent_assets = [
            {"asset_key": "hero_bg", "label": "Hero Background", "media_type": "image"},
            {"asset_key": "primary_logo", "label": "Primary Logo", "media_type": "image"},
        ]
        selected, missing = resolve_selected_assets(["primary_logo", "unknown_asset"], agent_assets)
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["asset_key"], "primary_logo")
        self.assertEqual(missing, ["unknown_asset"])


class TestWorkflowReferenceImages(unittest.TestCase):
    """Test _get_workflow_reference_images folder asset lookup & filtering."""

    @patch("research_agent.tools.unified_image._supabase_client")
    @patch("research_agent.tools.unified_image.get_agent_brand_assets")
    def test_filter_by_reference_asset_keys(self, mock_get_assets, mock_supabase):
        mock_client = MagicMock()
        mock_client.table().select().eq().eq().execute.return_value.data = [{"id": "agent-123"}]
        mock_supabase.return_value = mock_client

        mock_get_assets.return_value = [
            {"asset_key": "key_1", "media_type": "image", "public_url": "https://r2.example.com/img1.png"},
            {"asset_key": "key_2", "media_type": "image", "public_url": "https://r2.example.com/img2.png"},
            {"asset_key": "key_3", "media_type": "image", "public_url": "https://r2.example.com/img3.png"},
            {"asset_key": "doc_1", "media_type": "document", "public_url": "https://r2.example.com/doc.pdf"},
        ]

        images = _get_workflow_reference_images("wf-1", reference_asset_keys=["key_2", "key_3"])
        self.assertEqual(len(images), 2)
        self.assertIn("https://r2.example.com/img2.png", images)
        self.assertIn("https://r2.example.com/img3.png", images)
        self.assertNotIn("https://r2.example.com/img1.png", images)

    @patch("research_agent.tools.unified_image._supabase_client")
    @patch("research_agent.tools.unified_image.get_agent_brand_assets")
    def test_all_folder_images_when_no_keys_specified(self, mock_get_assets, mock_supabase):
        mock_client = MagicMock()
        mock_client.table().select().eq().eq().execute.return_value.data = [{"id": "agent-123"}]
        mock_supabase.return_value = mock_client

        mock_get_assets.return_value = [
            {"asset_key": "img_a", "media_type": "image", "public_url": "https://r2.example.com/a.png"},
            {"asset_key": "doc_b", "media_type": "document", "public_url": "https://r2.example.com/b.pdf"},
        ]

        images = _get_workflow_reference_images("wf-1")
        self.assertEqual(images, ["https://r2.example.com/a.png"])


class TestDirectContextMiddleware(unittest.TestCase):
    """Test BrandAssetContextMiddleware format and message building."""

    def test_direct_url_message_building(self):
        middleware = BrandAssetContextMiddleware()
        payload = {
            "query": "Check colors",
            "assets": [
                {
                    "asset_key": "logo",
                    "media_type": "image",
                    "url": "https://cdn.example.com/logo.png"
                }
            ]
        }
        msg = middleware._build_message(payload)
        self.assertIsInstance(msg, HumanMessage)
        self.assertEqual(len(msg.content), 2)
        self.assertEqual(msg.content[1]["type"], "image_url")
        self.assertEqual(msg.content[1]["image_url"]["url"], "https://cdn.example.com/logo.png")


    def test_multiple_parallel_tool_messages_aggregation(self):
        from langchain_core.messages import AIMessage, ToolMessage
        middleware = BrandAssetContextMiddleware()
        
        # Simulate an AI message requesting 3 tool calls, followed by 3 ToolMessages
        ai_msg = AIMessage(content="", tool_calls=[
            {"id": "tc1", "name": "omni_analyzer", "args": {}},
            {"id": "tc2", "name": "omni_analyzer", "args": {}},
            {"id": "tc3", "name": "omni_analyzer", "args": {}},
        ])
        tm1 = ToolMessage(
            content=build_direct_context_payload("query 1", [{"asset_key": "img_1", "media_type": "image", "url": "https://example.com/1.png"}]),
            tool_call_id="tc1"
        )
        tm2 = ToolMessage(
            content=build_direct_context_payload("query 2", [{"asset_key": "img_2", "media_type": "image", "url": "https://example.com/2.png"}]),
            tool_call_id="tc2"
        )
        tm3 = ToolMessage(
            content=build_direct_context_payload("query 3", [{"asset_key": "img_3", "media_type": "image", "url": "https://example.com/3.png"}]),
            tool_call_id="tc3"
        )

        messages = [HumanMessage(content="analyze these"), ai_msg, tm1, tm2, tm3]
        payload = middleware._latest_direct_context(messages)

        self.assertIsNotNone(payload)
        self.assertEqual(len(payload["assets"]), 3)
        keys = [a["asset_key"] for a in payload["assets"]]
        self.assertEqual(keys, ["img_1", "img_2", "img_3"])
        self.assertIn("query 1", payload["query"])
        self.assertIn("query 2", payload["query"])
        self.assertIn("query 3", payload["query"])

    @patch("httpx.get")
    def test_jfif_normalization_in_build_message(self, mock_get):
        import io
        from PIL import Image
        middleware = BrandAssetContextMiddleware()

        # Create a tiny 10x10 RGB image in memory
        img = Image.new("RGB", (10, 10), color="blue")
        img_bytes_io = io.BytesIO()
        img.save(img_bytes_io, format="JPEG")
        fake_jpeg_bytes = img_bytes_io.getvalue()

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.content = fake_jpeg_bytes
        mock_get.return_value = mock_resp

        payload = {
            "query": "Inspect jfif",
            "assets": [
                {
                    "asset_key": "jfif_test",
                    "media_type": "image",
                    "url": "https://r2.example.com/sample.jfif"
                }
            ]
        }
        msg = middleware._build_message(payload)
        self.assertIsInstance(msg, HumanMessage)
        self.assertEqual(len(msg.content), 2)
        self.assertEqual(msg.content[1]["type"], "image_url")
        # Should be normalized to base64 data URI
        self.assertTrue(msg.content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,"))


class TestReactiveMediaHealing(unittest.IsolatedAsyncioTestCase):
    """Test _aheal_unsupported_media in chat_model."""

    @patch("research_agent.preflight.run_omni_gemini_direct_async")
    @patch("research_agent.tools.provider_engine.get_settings")
    async def test_aheal_replaces_image_with_analysis_text(self, mock_settings, mock_omni):
        from research_agent.chat_model import _aheal_unsupported_media

        mock_settings.return_value = {"omni_provider": "gemini", "omni_model": "gemini-3.1-flash-lite"}
        mock_omni.return_value = "A high-resolution image of a sunset over mountains."

        kwargs = {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "What is in this image?"},
                        {"type": "image_url", "image_url": {"url": "https://example.com/sunset.jpg"}}
                    ]
                }
            ]
        }

        healed = await _aheal_unsupported_media(kwargs, user_id="test_user")
        self.assertIn("messages", healed)
        healed_msg = healed["messages"][0]
        # Media block should be converted to text analysis
        self.assertIsInstance(healed_msg["content"], str)
        self.assertIn("A high-resolution image of a sunset over mountains", healed_msg["content"])
        self.assertIn("What is in this image?", healed_msg["content"])


if __name__ == "__main__":
    unittest.main()


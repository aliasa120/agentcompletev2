"""Test for Brave image search and download storage flow."""

import io
import os
import sys
import unittest
from unittest.mock import patch, MagicMock
from PIL import Image

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from research_agent.tools.fetch_images_brave import fetch_images_brave
from research_agent.tools.create_post_image_gemini import create_post_image_gemini
from research_agent.tools.terminal_tool import terminal
from research_agent.fs_backend import get_thread_output_dir


class TestBraveImageStorageFlow(unittest.TestCase):

    def setUp(self):
        self.test_tid = "test_brave_thread_01"
        self.thread_dir = get_thread_output_dir(self.test_tid, create=True)

    def tearDown(self):
        import shutil
        if os.path.exists(self.thread_dir):
            try:
                shutil.rmtree(self.thread_dir)
            except Exception:
                pass

    @patch("requests.get")
    @patch("research_agent.tools.provider_engine.get_user_api_key")
    def test_brave_search_returns_urls_without_disk_or_r2_bloat(self, mock_get_key, mock_requests_get):
        mock_get_key.return_value = "mock_brave_key"
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "results": [
                {
                    "title": "Pakistan Space Program Launch",
                    "source": "https://news.example.com",
                    "properties": {
                        "url": "https://news.example.com/photos/launch.jpg",
                        "width": 1200,
                        "height": 800,
                    },
                }
            ]
        }
        mock_requests_get.return_value = mock_resp

        result = fetch_images_brave.invoke({"query": "Pakistan space launch", "count": 1})
        self.assertIn("Pakistan Space Program Launch", result)
        self.assertIn("https://news.example.com/photos/launch.jpg", result)

        # Confirm no files were written to local disk during search
        self.assertEqual(len(os.listdir(self.thread_dir)), 0)

    @patch("requests.get")
    @patch("research_agent.storage_service.auto_upload_enabled", return_value=False)
    @patch("research_agent.storage_service.upload_file")
    def test_brave_image_download_stays_local_by_default(
        self, mock_storage_upload, _mock_gate, mock_get
    ):
        """An image downloaded by a script lands in the thread workspace only.

        Cloud storage is reserved for explicit ``upload_to_storage`` calls, so a
        routine download must not consume R2/Supabase or retention budget.
        """
        img_bytes = self._dummy_jpeg()
        self._write_download_script(img_bytes)

        config = {"configurable": {"thread_id": self.test_tid}}
        res = terminal.invoke({"command": "python download_img.py"}, config=config)

        self.assertIn("Image downloaded successfully", res)
        self.assertIn("(exit 0)", res)

        # 1. Physical image exists on local disk
        downloaded_file = os.path.join(self.thread_dir, "downloaded_news.jpg")
        self.assertTrue(os.path.exists(downloaded_file))

        # 2. No cloud upload, but the agent is told the file was created
        mock_storage_upload.assert_not_called()
        self.assertIn("downloaded_news.jpg", res)
        self.assertIn("upload_to_storage", res)

    @patch("requests.get")
    @patch("research_agent.storage_service.auto_upload_enabled", return_value=True)
    @patch("research_agent.storage_service.upload_file")
    def test_brave_image_download_dual_syncs_when_enabled(
        self, mock_storage_upload, _mock_gate, mock_get
    ):
        """With ``storage_auto_upload_files`` on, new files mirror to R2 as before."""
        mock_storage_upload.return_value = "https://r2.example.com/images/downloaded_news.jpg"
        self._write_download_script(self._dummy_jpeg())

        config = {"configurable": {"thread_id": self.test_tid}}
        res = terminal.invoke({"command": "python download_img.py"}, config=config)
        self.assertIn("(exit 0)", res)

        downloaded_file = os.path.join(self.thread_dir, "downloaded_news.jpg")
        self.assertTrue(os.path.exists(downloaded_file))

        mock_storage_upload.assert_called()
        found_upload = False
        for call in mock_storage_upload.call_args_list:
            if call[1].get("filename") == "downloaded_news.jpg":
                found_upload = True
                self.assertEqual(call[1].get("category"), "images")
                self.assertEqual(call[1].get("thread_id"), self.test_tid)
        self.assertTrue(found_upload, "downloaded_news.jpg was not synced to storage_service")
        self.assertIn("FILE_URL:", res)

    # ── helpers ────────────────────────────────────────────────────────────────

    def _dummy_jpeg(self) -> bytes:
        img = Image.new("RGB", (200, 200), color="blue")
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        return buf.getvalue()

    def _write_download_script(self, img_bytes: bytes) -> None:
        """Simulate the agent's script writing a downloaded photo locally."""
        local_script = (
            "import os\n"
            "with open('downloaded_news.jpg', 'wb') as f:\n"
            f"    f.write({repr(img_bytes)})\n"
            "print('Image downloaded successfully')\n"
        )
        with open(os.path.join(self.thread_dir, "download_img.py"), "w", encoding="utf-8") as f:
            f.write(local_script)


if __name__ == "__main__":
    unittest.main()

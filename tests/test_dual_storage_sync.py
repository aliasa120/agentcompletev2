"""Tests for storage behaviour: workspace-local writes, opt-in cloud mirroring,
and the explicit ``upload_to_storage`` tool.

Policy under test
-----------------
Agent-created files stay on local disk in ``output/threads/<thread_id>/`` and are
mirrored into LangGraph state (small text files) so the UI can open them. Cloud
storage is used only when a shareable URL is needed:

* explicitly, via the ``upload_to_storage`` tool,
* or for everything, when ``storage_auto_upload_files`` is switched on.
"""

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from research_agent.fs_backend import (
    get_thread_output_dir,
    get_thread_filesystem_backend,
    ThreadFilesystemBackend,
    THREADS_ROOT,
)
from research_agent.tools.terminal_tool import terminal, upload_file_to_supabase
from research_agent.tools.upload_to_storage import (
    upload_to_storage,
    classify_category,
    resolve_local_file,
)
from research_agent import storage_service


class _ThreadDirTestCase(unittest.TestCase):
    """Creates and cleans an isolated thread workspace for each test."""

    thread_id = "test_storage_policy_thread_01"

    def setUp(self):
        import shutil

        self.test_tid = self.thread_id
        self.thread_dir = get_thread_output_dir(self.test_tid, create=False)
        if os.path.exists(self.thread_dir):
            shutil.rmtree(self.thread_dir, ignore_errors=True)
        os.makedirs(self.thread_dir, exist_ok=True)

    def tearDown(self):
        import shutil

        if os.path.exists(self.thread_dir):
            shutil.rmtree(self.thread_dir, ignore_errors=True)


class TestWorkspaceWritesStayLocal(_ThreadDirTestCase):
    """Default policy: write locally, mirror to state, do NOT touch cloud storage."""

    @patch("research_agent.storage_service.auto_upload_enabled", return_value=False)
    @patch("research_agent.storage_service.upload_file")
    def test_write_is_local_only_by_default(self, mock_upload, _mock_gate):
        backend = ThreadFilesystemBackend(root_dir=self.thread_dir, virtual_mode=True)

        res = backend.write("test_report.md", "# Test Report\nLocal content.")
        self.assertIsNone(res.error)

        # 1. File exists locally with exact content
        local_file = os.path.join(self.thread_dir, "test_report.md")
        self.assertTrue(os.path.exists(local_file))
        with open(local_file, "r", encoding="utf-8") as f:
            self.assertEqual(f.read(), "# Test Report\nLocal content.")

        # 2. No cloud upload happened
        mock_upload.assert_not_called()

        # 3. Content is mirrored into LangGraph state so the UI can open it
        self.assertEqual(res.files_update, {"/test_report.md": "# Test Report\nLocal content."})

    @patch("research_agent.storage_service.auto_upload_enabled", return_value=False)
    @patch("research_agent.storage_service.upload_file")
    def test_edit_is_local_only_by_default(self, mock_upload, _mock_gate):
        backend = ThreadFilesystemBackend(root_dir=self.thread_dir, virtual_mode=True)
        backend.write("presentation.txt", "Initial slide 1")
        mock_upload.reset_mock()

        res = backend.edit("presentation.txt", "Initial slide 1", "Updated slide 1 with charts")
        self.assertIsNone(res.error)

        local_file = os.path.join(self.thread_dir, "presentation.txt")
        with open(local_file, "r", encoding="utf-8") as f:
            self.assertIn("Updated slide 1 with charts", f.read())

        mock_upload.assert_not_called()
        self.assertEqual(res.files_update, {"/presentation.txt": "Updated slide 1 with charts"})

    @patch("research_agent.storage_service.auto_upload_enabled", return_value=False)
    @patch("research_agent.storage_service.upload_file")
    def test_binary_extension_is_not_mirrored_into_state(self, mock_upload, _mock_gate):
        """Binaries are served by the thread-files API, not carried in state."""
        backend = ThreadFilesystemBackend(root_dir=self.thread_dir, virtual_mode=True)

        res = backend.write("archive.bin", "raw-bytes-placeholder")
        self.assertIsNone(res.error)
        self.assertTrue(os.path.exists(os.path.join(self.thread_dir, "archive.bin")))
        self.assertIsNone(res.files_update)
        mock_upload.assert_not_called()


class TestOptInAutoUpload(_ThreadDirTestCase):
    """``storage_auto_upload_files`` restores the legacy dual-write behaviour."""

    @patch("research_agent.storage_service.auto_upload_enabled", return_value=True)
    @patch("research_agent.storage_service.upload_file")
    def test_write_dual_syncs_when_enabled(self, mock_upload, _mock_gate):
        mock_upload.return_value = "https://r2.example.com/documents/test_report.md"
        backend = ThreadFilesystemBackend(root_dir=self.thread_dir, virtual_mode=True)

        res = backend.write("test_report.md", "# Test Report\nDual write content.")
        self.assertIsNone(res.error)
        self.assertTrue(os.path.exists(os.path.join(self.thread_dir, "test_report.md")))

        mock_upload.assert_called_once()
        _args, kwargs = mock_upload.call_args
        self.assertEqual(kwargs.get("filename"), "test_report.md")
        self.assertEqual(kwargs.get("category"), "documents")

    @patch("research_agent.storage_service.auto_upload_enabled", return_value=True)
    @patch("research_agent.storage_service.upload_file")
    def test_edit_dual_syncs_when_enabled(self, mock_upload, _mock_gate):
        mock_upload.return_value = "https://r2.example.com/documents/presentation.txt"
        backend = ThreadFilesystemBackend(root_dir=self.thread_dir, virtual_mode=True)

        backend.write("presentation.txt", "Initial slide 1")
        mock_upload.reset_mock()

        res = backend.edit("presentation.txt", "Initial slide 1", "Updated slide 1 with charts")
        self.assertIsNone(res.error)

        mock_upload.assert_called_once()
        _args, kwargs = mock_upload.call_args
        self.assertEqual(kwargs.get("filename"), "presentation.txt")

    @patch("research_agent.storage_service.auto_upload_enabled", return_value=True)
    @patch("research_agent.storage_service.upload_file")
    def test_local_write_survives_storage_failure(self, mock_upload, _mock_gate):
        # If the cloud upload raises, the local write must still succeed.
        mock_upload.side_effect = RuntimeError("R2 network timeout")
        backend = ThreadFilesystemBackend(root_dir=self.thread_dir, virtual_mode=True)

        res = backend.write("resilient.py", "print('always written locally')")
        self.assertIsNone(res.error)
        self.assertTrue(os.path.exists(os.path.join(self.thread_dir, "resilient.py")))


class TestAutoUploadGate(unittest.TestCase):
    """Resolution of the ``storage_auto_upload_files`` setting."""

    @patch("research_agent.tools.provider_engine.get_settings", return_value={})
    def test_disabled_by_default(self, _mock_settings):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(storage_service.AUTO_UPLOAD_ENV_KEY, None)
            self.assertFalse(storage_service.auto_upload_enabled())

    @patch("research_agent.tools.provider_engine.get_settings", return_value={})
    def test_enabled_via_env(self, _mock_settings):
        with patch.dict(os.environ, {storage_service.AUTO_UPLOAD_ENV_KEY: "true"}):
            self.assertTrue(storage_service.auto_upload_enabled())

    @patch(
        "research_agent.tools.provider_engine.get_settings",
        return_value={storage_service.AUTO_UPLOAD_SETTING_KEY: "true"},
    )
    def test_enabled_via_agent_settings(self, _mock_settings):
        self.assertTrue(storage_service.auto_upload_enabled())


class TestUploadToStorageTool(_ThreadDirTestCase):
    """The explicit path: "make this PDF and give me its link"."""

    def _config(self):
        return {"configurable": {"thread_id": self.test_tid}}

    def test_category_classification(self):
        self.assertEqual(classify_category("report.pdf"), "documents")
        self.assertEqual(classify_category("chart.PNG"), "images")
        self.assertEqual(classify_category("voice.mp3"), "audio")
        self.assertEqual(classify_category("clip.mp4"), "video")
        self.assertEqual(classify_category("blob.unknownext"), "workspace")

    def test_resolves_relative_workspace_path(self):
        target = os.path.join(self.thread_dir, "notes.md")
        with open(target, "w", encoding="utf-8") as f:
            f.write("hello")

        self.assertEqual(resolve_local_file("notes.md", self._config()), os.path.abspath(target))
        # Agents also emit virtual absolute paths like "/notes.md"
        self.assertEqual(resolve_local_file("/notes.md", self._config()), os.path.abspath(target))

    @patch("research_agent.storage_service.upload_file")
    def test_returns_public_url_and_file_marker(self, mock_upload):
        mock_upload.return_value = "https://pub-test.r2.dev/documents/2026-09-01/t/ab12_report.pdf"
        target = os.path.join(self.thread_dir, "report.pdf")
        with open(target, "wb") as f:
            f.write(b"%PDF-1.4 content")

        result = upload_to_storage.invoke({"file_path": "report.pdf"}, config=self._config())

        self.assertIn("[Success]", result)
        self.assertIn(mock_upload.return_value, result)
        # FILE_URL: marker is what the chat UI turns into a download card
        self.assertIn(f"FILE_URL:{mock_upload.return_value}", result)

        _args, kwargs = mock_upload.call_args
        self.assertEqual(kwargs.get("filename"), "report.pdf")
        self.assertEqual(kwargs.get("category"), "documents")
        self.assertEqual(kwargs.get("thread_id"), self.test_tid)

    @patch("research_agent.storage_service.upload_file")
    def test_category_override_is_respected(self, mock_upload):
        mock_upload.return_value = "https://pub-test.r2.dev/images/x.bin"
        target = os.path.join(self.thread_dir, "x.bin")
        with open(target, "wb") as f:
            f.write(b"0123456789")

        upload_to_storage.invoke({"file_path": "x.bin", "category": "images"}, config=self._config())
        self.assertEqual(mock_upload.call_args[1].get("category"), "images")

    @patch("research_agent.storage_service.upload_file")
    def test_missing_file_reports_error_without_uploading(self, mock_upload):
        result = upload_to_storage.invoke({"file_path": "does_not_exist_zz.pdf"}, config=self._config())
        self.assertIn("[Error]", result)
        self.assertIn("not found", result.lower())
        mock_upload.assert_not_called()

    @patch("research_agent.storage_service.upload_file")
    def test_empty_file_reports_error_without_uploading(self, mock_upload):
        target = os.path.join(self.thread_dir, "empty.pdf")
        open(target, "wb").close()

        result = upload_to_storage.invoke({"file_path": "empty.pdf"}, config=self._config())
        self.assertIn("[Error]", result)
        mock_upload.assert_not_called()

    @patch("research_agent.storage_service.upload_file", return_value=None)
    def test_no_storage_backend_reports_error(self, _mock_upload):
        target = os.path.join(self.thread_dir, "report.pdf")
        with open(target, "wb") as f:
            f.write(b"%PDF-1.4 content")

        result = upload_to_storage.invoke({"file_path": "report.pdf"}, config=self._config())
        self.assertIn("[Error]", result)
        self.assertIn("storage backend", result)


class TestTerminalUploadHelper(_ThreadDirTestCase):
    """`upload_file_to_supabase` keeps its extension â†’ category mapping."""

    @patch("research_agent.storage_service.upload_file")
    def test_terminal_tool_category_classification(self, mock_upload):
        mock_upload.return_value = "https://r2.example.com/uploaded"

        pdf_path = os.path.join(self.thread_dir, "sample.pdf")
        with open(pdf_path, "wb") as f:
            f.write(b"%PDF-1.4 sample")
        upload_file_to_supabase(pdf_path, thread_id=self.test_tid)
        self.assertEqual(mock_upload.call_args[1].get("category"), "documents")

        mock_upload.reset_mock()
        img_path = os.path.join(self.thread_dir, "photo.png")
        with open(img_path, "wb") as f:
            f.write(b"\x89PNG sample")
        upload_file_to_supabase(img_path, thread_id=self.test_tid)
        self.assertEqual(mock_upload.call_args[1].get("category"), "images")

        mock_upload.reset_mock()
        audio_path = os.path.join(self.thread_dir, "speech.mp3")
        with open(audio_path, "wb") as f:
            f.write(b"ID3 sample")
        upload_file_to_supabase(audio_path, thread_id=self.test_tid)
        self.assertEqual(mock_upload.call_args[1].get("category"), "audio")

        mock_upload.reset_mock()
        script_path = os.path.join(self.thread_dir, "run.sh")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write("echo hello")
        upload_file_to_supabase(script_path, thread_id=self.test_tid)
        self.assertEqual(mock_upload.call_args[1].get("category"), "terminal")


if __name__ == "__main__":
    unittest.main()

"""Unit and integration tests for thread-scoped FilesystemBackend and terminal execution."""

import os
import sys
import shutil
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from langchain_core.runnables import RunnableConfig

from research_agent.fs_backend import (
    get_thread_output_dir,
    get_thread_filesystem_backend,
    sanitize_thread_id,
    THREADS_ROOT,
)
from research_agent.tools.terminal_tool import terminal


class TestThreadFilesystem(unittest.TestCase):

    def setUp(self):
        # Clean test directories before each test
        for tid in ["test_unit_thread_01", "test_unit_thread_02", "test_unit_thread_03",
                    "test_thread_sales_101", "test_thread_comp_102", "test_thread_reportlab_pdf"]:
            d = os.path.join(THREADS_ROOT, tid)
            if os.path.exists(d):
                try:
                    shutil.rmtree(d)
                except Exception:
                    pass

    def test_sanitize_thread_id(self):
        self.assertEqual(sanitize_thread_id("thread-123"), "thread-123")
        self.assertEqual(sanitize_thread_id("thread/456:abc"), "thread_456_abc")
        self.assertEqual(sanitize_thread_id(""), "default")
        self.assertEqual(sanitize_thread_id(None), "default")

    def test_thread_directory_creation(self):
        tid = "test_unit_thread_01"
        expected_dir = os.path.abspath(os.path.join(THREADS_ROOT, tid))
        
        resolved_dir = get_thread_output_dir(tid, create=True)
        self.assertEqual(resolved_dir, expected_dir)
        self.assertTrue(os.path.isdir(resolved_dir))

    def test_thread_filesystem_backend_write_and_read(self):
        tid = "test_unit_thread_02"
        thread_dir = get_thread_output_dir(tid)
        
        class MockRuntime:
            def __init__(self, thread_id):
                self.config = {"configurable": {"thread_id": thread_id}}

        runtime = MockRuntime(tid)
        backend = get_thread_filesystem_backend(runtime)
        
        write_res = backend.write("test_script.py", "print('Hello from thread 02')\n")
        self.assertIsNone(write_res.error)
        
        expected_file = os.path.join(thread_dir, "test_script.py")
        self.assertTrue(os.path.exists(expected_file))
        with open(expected_file, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertIn("Hello from thread 02", content)

    def test_terminal_executes_in_thread_directory(self):
        tid = "test_unit_thread_03"
        thread_dir = get_thread_output_dir(tid)
        config: RunnableConfig = {"configurable": {"thread_id": tid}}
        
        backend = get_thread_filesystem_backend({"configurable": {"thread_id": tid}})
        backend.write(
            "generate_data.py",
            "with open('output_data.txt', 'w') as f:\n    f.write('Thread 03 result data')\nprint('Done generating')"
        )
        
        res = terminal.invoke({"command": "python generate_data.py"}, config=config)
        self.assertIn("Done generating", res)
        self.assertIn("(exit 0)", res)
        
        output_file = os.path.join(thread_dir, "output_data.txt")
        self.assertTrue(os.path.exists(output_file))
        with open(output_file, "r", encoding="utf-8") as f:
            data = f.read()
        self.assertIn("Thread 03 result data", data)

    def test_thread_isolation_between_two_threads(self):
        tid1 = "test_thread_sales_101"
        tid2 = "test_thread_comp_102"
        
        dir1 = get_thread_output_dir(tid1)
        dir2 = get_thread_output_dir(tid2)
        
        config1: RunnableConfig = {"configurable": {"thread_id": tid1}}
        config2: RunnableConfig = {"configurable": {"thread_id": tid2}}
        
        backend1 = get_thread_filesystem_backend({"configurable": {"thread_id": tid1}})
        backend2 = get_thread_filesystem_backend({"configurable": {"thread_id": tid2}})
        
        # Thread 1 creates a sales report script
        backend1.write(
            "sales_pdf.py",
            "import os\nwith open('sales.pdf', 'w') as f: f.write('%PDF-1.4 sales')\nprint('Sales PDF generated')"
        )
        
        # Thread 2 creates a comparison report script
        backend2.write(
            "comparison_pdf.py",
            "import os\nwith open('comparison.pdf', 'w') as f: f.write('%PDF-1.4 comparison')\nprint('Comparison PDF generated')"
        )
        
        # Execute in Thread 1
        res1 = terminal.invoke({"command": "python sales_pdf.py"}, config=config1)
        self.assertIn("Sales PDF generated", res1)
        self.assertTrue(os.path.exists(os.path.join(dir1, "sales.pdf")))
        self.assertFalse(os.path.exists(os.path.join(dir2, "sales.pdf")))
        
        # Execute in Thread 2
        res2 = terminal.invoke({"command": "python comparison_pdf.py"}, config=config2)
        self.assertIn("Comparison PDF generated", res2)
        self.assertTrue(os.path.exists(os.path.join(dir2, "comparison.pdf")))
        self.assertFalse(os.path.exists(os.path.join(dir1, "comparison.pdf")))

    def test_e2e_reportlab_pdf_creation_in_thread(self):
        tid = "test_thread_reportlab_pdf"
        thread_dir = get_thread_output_dir(tid)
        config: RunnableConfig = {"configurable": {"thread_id": tid}}
        
        backend = get_thread_filesystem_backend({"configurable": {"thread_id": tid}})
        
        pdf_script = """
import os
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet

doc = SimpleDocTemplate("sales_report.pdf", pagesize=letter)
styles = getSampleStyleSheet()
story = [
    Paragraph("Sales & Revenue Report", styles["Title"]),
    Spacer(1, 12),
    Paragraph("Q1 vs Q2 Performance Comparison", styles["Heading2"]),
    Spacer(1, 8),
    Paragraph("Revenue grew by 24% over the previous quarter.", styles["Normal"]),
]
doc.build(story)
print("PDF_BUILD_SUCCESS")
"""
        backend.write("build_sales_report.py", pdf_script)
        
        res = terminal.invoke({"command": "python build_sales_report.py"}, config=config)
        self.assertIn("PDF_BUILD_SUCCESS", res)
        self.assertIn("(exit 0)", res)
        
        pdf_path = os.path.join(thread_dir, "sales_report.pdf")
        self.assertTrue(os.path.exists(pdf_path))
        self.assertGreater(os.path.getsize(pdf_path), 1000)
        
        with open(pdf_path, "rb") as f:
            header = f.read(5)
        self.assertEqual(header, b"%PDF-")

    def test_cd_tmp_normalization_on_windows(self):
        tid = "test_thread_tmp_norm"
        thread_dir = get_thread_output_dir(tid)
        config: RunnableConfig = {"configurable": {"thread_id": tid}}
        
        backend = get_thread_filesystem_backend({"configurable": {"thread_id": tid}})
        # Write a script inside virtual /tmp/prd_charts/make_charts.py
        backend.write("tmp/prd_charts/make_charts.py", "print('Charts generated in tmp!')")
        
        # Invoke cd /tmp/prd_charts && python make_charts.py
        res = terminal.invoke({"command": "cd /tmp/prd_charts && python make_charts.py"}, config=config)
        self.assertIn("Charts generated in tmp!", res)
        self.assertIn("(exit 0)", res)


if __name__ == "__main__":
    unittest.main()

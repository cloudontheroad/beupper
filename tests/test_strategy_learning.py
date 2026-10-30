"""Regression: an optional promotion audit cannot discard a successful review."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("strategy_iteration", Path(__file__).resolve().parents[1] / "scripts" / "strategy_iteration.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LearningTest(unittest.TestCase):
    def test_audit_failure_preserves_review_and_key_free_snapshot(self):
        response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({"summary": "test", "topicDirectives": ["按真实讨论需求比较选题"]})))], id="receipt-test", model="fake", usage=None)
        calls = []

        def create(**kwargs):
            calls.append(kwargs)
            if len(calls) > 1:
                raise RuntimeError("audit failed")
            return response

        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        with tempfile.TemporaryDirectory() as directory:
            fake_source = Path(directory) / "scripts" / "strategy_iteration.py"
            with patch.object(module, "__file__", str(fake_source)), patch.object(module.openai, "OpenAI", return_value=client):
                result = module.generate_strategy_iteration({
                    "apiKey": "private-test-key", "records": [{"projectMatched": False, "title": "test", "performance": {"platformId": "post1", "views": 30}}],
                    "strategyHistory": [{"id": "old1", "createdAt": "2026-01-01T00:00:00Z"}, {"id": "old2", "createdAt": "2026-02-01T00:00:00Z"}],
                })
            self.assertTrue(result["ok"])
            self.assertEqual(result["iteration"]["receipt"], "receipt-test")
            self.assertEqual(result["iteration"]["matchedProjectCount"], 0)
            self.assertIn("RuntimeError", result["promotionWarning"])
            self.assertEqual(len(calls), 2)
            saved = (Path(directory) / "data" / "strategy" / "latest-input.json").read_text(encoding="utf-8")
            self.assertNotIn("private-test-key", saved)
            self.assertTrue((Path(directory) / "data" / "strategy" / "latest-iteration.json").exists())


if __name__ == "__main__":
    unittest.main()

import sys
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import social_sources as social


class SocialSourcesTest(unittest.TestCase):
    def test_both_failed_is_not_success(self):
        with patch.object(social, "search_xueqiu", return_value=([], "blocked")), patch.object(social, "search_twitter", return_value=([], "offline")):
            result = social.collect_social_sources({"queries": ["公司"]})
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], 502)

    def test_partial_preserves_successful_channel(self):
        with patch.object(social, "search_xueqiu", return_value=([], "blocked")), patch.object(social, "search_twitter", return_value=([{"url": "https://x.com/a/status/1"}], "")):
            result = social.collect_social_sources({"queries": ["公司"]})
        self.assertTrue(result["ok"])
        self.assertTrue(result["partial"])
        self.assertEqual(len(result["references"]), 1)

    def test_endpoint_exception_still_attempts_webpage(self):
        page = MagicMock()
        page.evaluate.side_effect = RuntimeError("Failed to fetch")
        page.locator.return_value.count.return_value = 0
        page.locator.return_value.inner_text.return_value = "请求异常已被安全策略拦截"
        context = MagicMock()
        context.pages = [page]
        context.cookies.return_value = []
        with patch.object(social, "_with_browser", side_effect=lambda platform, callback: callback(context)):
            rows, error = social.search_xueqiu("公司", "")
        self.assertFalse(rows)
        self.assertIn("安全策略拦截", error)
        self.assertTrue(any("/k?q=" in str(call) for call in page.goto.call_args_list))


if __name__ == "__main__":
    unittest.main()

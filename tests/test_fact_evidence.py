import sys
from pathlib import Path
import unittest
from datetime import datetime, timezone, timedelta

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from poe_script import _parse_evidence_time, build_fresh_fact_corpus


class FactEvidenceTest(unittest.TestCase):
    def test_timestamp_formats(self):
        expected = _parse_evidence_time("2026-10-30T14:00:00+08:00")
        self.assertEqual(_parse_evidence_time("2026年10月30日 14:00:00"), expected)
        self.assertEqual(_parse_evidence_time(str(int(expected.timestamp() * 1000))), expected)
        self.assertIsNone(_parse_evidence_time("昨天"))

    def test_aliases_keep_real_source_but_not_social_or_expired(self):
        now = datetime.now(timezone.utc)
        base = {"title": "公告", "url": "https://example.com/announcement", "content": "公告正文中的营业收入", "published_time": now.isoformat()}
        corpus, _ = build_fresh_fact_corpus({"evidence": [base]})
        self.assertIn("营业收入", corpus)
        diagnoses = []
        corpus, rejected = build_fresh_fact_corpus({"evidence": [dict(base, social=True), dict(base, published_time=(now - timedelta(hours=80)).isoformat()), dict(base, content="")]}, diagnoses)
        self.assertFalse(corpus)
        self.assertEqual(len(rejected), 3)
        self.assertEqual([d["reason"] for d in diagnoses], ["社区观点不是行情事实源", "来源已超过72小时", "缺少证据正文或摘要"])


if __name__ == "__main__":
    unittest.main()

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / ".python_packages"))

import httpx
import openai

from strategy_iteration import _sanitize_strategy


SKILL_PATH = Path(__file__).resolve().parents[1] / "skills" / "package-financial-video" / "SKILL.md"
SYSTEM = """你是“金融巨子”的财经视频包装总编。你的工作不是写正文，而是从当前实时热点的完整证据中，生成三套真正属于这一次事件的标题、Hook、封面文案与视觉方向。禁止调用历史题目模板，禁止把同属外汇、科技或政策类别的旧事件替换进来。

事实只能来自输入。标题可以有张力，但不得发明数字、人物动作、政策因果或价格表现。标题因果强度不得高于证据：只有价格事实时使用问题或“市场在交易什么”，不能写成某主体“踩刹车”“出逃”导致涨跌。跨市场非重叠交易时段不得包装成同一消息下的同步反应；必须保留交易日、时区与信息截点。输出必须是一个可解析JSON对象，不要Markdown、解释、前后缀或代码围栏。

严格执行本次请求附带的当前Skill。"""

SYSTEM += """
封面用于不显示视频标题的抖音主页与历史作品网格。cover字段必须输出准确主体名加本期钩子的完整文字，最多两行，通常6至16字。主体写当前公司的常用简称、具名人物名、资产名或具体行业政策对象，不用照片或Logo代替文字。主体名可以重复标题关键词；钩子仍应互补。不得只输出无主体的情绪口号。旧研究底稿的4至8字或不重复标题要求不得覆盖主体识别要求。
"""


REQUIRED_TEXT_FIELDS = ("title", "hook", "cover", "type", "motive", "keyword", "conflict", "coverMode", "visual", "visualSubjectType")


SYSTEM += """
财报包装遵循公司优先原则：单一上市公司的财报、业绩预告、经营指引或资本开支更新，标题、Hook和封面必须首先回答这家公司未来股价怎么看。优先呈现盈利预期差、指引变化、估值锚、财报后价格反应和下一验证信号。行业、供应链与跨市场影响只能是第二层，不能取代本股成为主题；除非证据明确显示多家公司同步变化或行业盈利预测普遍修正，才可升级为行业主线。

后台实证约束：包装必须先服务前60秒兑现，不得只追求封面刺激。搜索型题目保留准确实体、新动作和数字；推荐型题目突出普通股民能立刻理解的利益冲突；双引擎题同时满足。封面点击率不能在没有同口径可比证据时被当作抖音推荐流表现的解释变量。禁止复用“黄金坑还是豪赌”“下一步看什么”“三个信号”等空模板，除非后半句已经点明本事件独有的验证变量。具体效果判断以输入中的最新版抖音策略及其数据边界为准。
"""

def parse_json(text):
    clean = text.strip()
    clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", clean, flags=re.I | re.S)
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", clean, re.S)
        if not match:
            raise
        return json.loads(match.group(0))


def normalize(payload):
    packages = payload.get("packages") if isinstance(payload, dict) else None
    if not isinstance(packages, list) or len(packages) != 3:
        raise ValueError("必须恰好返回三套包装方案")
    normalized = []
    for index, item in enumerate(packages):
        if not isinstance(item, dict):
            raise ValueError(f"第{index + 1}套方案不是对象")
        result = {}
        for field in REQUIRED_TEXT_FIELDS:
            value = str(item.get(field, "")).strip()
            if not value:
                raise ValueError(f"第{index + 1}套方案缺少{field}")
            result[field] = value.replace("——", "，") if field == "title" else value
        result["namedPerson"] = str(item.get("namedPerson", "")).strip()
        if result["visualSubjectType"] not in ("non_human", "named_real_person"):
            raise ValueError(f"第{index + 1}套方案的visualSubjectType非法")
        if result["visualSubjectType"] == "named_real_person" and not result["namedPerson"]:
            raise ValueError(f"第{index + 1}套人物方案缺少namedPerson")
        if result["visualSubjectType"] == "non_human":
            result["namedPerson"] = ""
        scores = item.get("scores") or {}
        result["scores"] = {
            key: max(0, min(100, int(float(scores.get(key, 0)))))
            for key in ("ctr", "search", "promise", "oral")
        }
        normalized.append(result)
    types = " ".join(item["type"] for item in normalized)
    if "问题" not in types or "结论" not in types:
        raise ValueError("三套方案必须同时包含好问题与清晰结论")
    return normalized


def generate_packaging(request_data):
    api_key = str(request_data.get("apiKey", "")).strip()
    model = str(request_data.get("model", "deepseek-v4-pro")).strip().lower() or "deepseek-v4-pro"
    topic = str(request_data.get("topic", "")).strip()
    context = request_data.get("topicContext") or {}
    research = [
        item for item in (request_data.get("research") or [])
        if isinstance(item, dict) and item.get("key") not in {"数据迭代", "策略约束"}
    ]
    strategy = _sanitize_strategy(request_data.get("strategyProfile") or {})
    if not api_key or not topic:
        return {"ok": False, "status": 400, "error": "缺少 DeepSeek API Key 或当前实时选题。"}

    brief = json.dumps({
        "account": "金融巨子",
        "audience": "关注A股、港股、美股及宏观联动的中文投资者",
        "selectedTopic": topic,
        "topicContext": context,
        "researchBrief": research,
        "latestDouyinStrategy": {
            "dataBoundary": strategy.get("dataBoundary", ""),
            "researchDirectives": strategy.get("researchDirectives", []),
            "scriptDirectives": strategy.get("scriptDirectives", []),
            "avoid": strategy.get("avoid", []),
        },
        "delivery": "生成三套差异化包装，不写口播正文",
    }, ensure_ascii=False, indent=2)
    try:
        client = openai.OpenAI(
            api_key=api_key,
            base_url="https://api.deepseek.com",
            timeout=httpx.Timeout(240.0, connect=30.0),
            max_retries=2,
        )
        current_skill = SKILL_PATH.read_text(encoding="utf-8") if SKILL_PATH.is_file() else ""
        messages = [
            {"role": "system", "content": SYSTEM + "\n\n以下是当前生效的包装Skill：\n" + current_skill},
            {"role": "user", "content": brief},
        ]
        last_error = ""
        receipts = []
        for attempt in range(2):
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                max_tokens=5000,
                response_format={"type": "json_object"},
                extra_body={"thinking": {"type": "disabled"}},
            )
            text = response.choices[0].message.content or ""
            usage = getattr(response, "usage", None)
            receipts.append({
                "responseId": getattr(response, "id", "") or "",
                "requestedModel": model,
                "actualModel": getattr(response, "model", "") or model,
                "inputTokens": getattr(usage, "prompt_tokens", None) if usage else None,
                "outputTokens": getattr(usage, "completion_tokens", None) if usage else None,
            })
            try:
                packages = normalize(parse_json(text))
                return {
                    "ok": True,
                    "packages": packages,
                    "model": model,
                    "provenance": {"provider": "DeepSeek API", "callCount": len(receipts), "receipts": receipts},
                }
            except (ValueError, json.JSONDecodeError) as error:
                last_error = str(error)
                messages += [
                    {"role": "assistant", "content": text},
                    {"role": "user", "content": f"上一次JSON不合格：{last_error}。保持当前实时选题不变，重新输出完整且可解析的JSON对象。"},
                ]
        return {"ok": False, "status": 422, "error": f"DeepSeek 包装结果连续两次未通过结构检查：{last_error}"}
    except openai.APIStatusError as error:
        return {"ok": False, "status": error.status_code, "error": f"DeepSeek {error.status_code}：{error.message}"}
    except openai.APITimeoutError:
        return {"ok": False, "status": 504, "error": "DeepSeek 生成包装超过4分钟仍未返回。"}
    except openai.APIConnectionError as error:
        return {"ok": False, "status": 502, "error": f"连接 DeepSeek 失败：{error}；底层原因：{error.__cause__!r}"}
    except Exception as error:
        return {"ok": False, "status": 502, "error": f"DeepSeek 包装调用失败：{type(error).__name__}: {error}"}

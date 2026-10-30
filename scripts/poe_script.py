import sys
import re
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlparse
from email.utils import parsedate_to_datetime

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / ".python_packages"))

import openai

from strategy_iteration import _sanitize_strategy
import httpx


WRITING_SKILL_PATH = Path(__file__).resolve().parents[1] / "skills" / "write-financial-video-script" / "SKILL.md"
WRITER_SYSTEM = """你是“金融巨子”的首席财经视频作者。你写的不是财经文章、研究报告或视频文案提纲，而是一个真正懂市场的人，坐在镜头前，把一件复杂财经事件讲成观众愿意一路听完的故事。每个字都必须是人会真的说出口的话。

写前确定本题要回答的一个问题，根据证据选择结构，不规定段数、留存单元或转折次数。底稿是证据池，不是正文目录。事实和数字必须有来源，不给买卖建议。

把事件讲成真实叙事，而不是观点拼盘。优先寻找一条能够被证据支持的故事线：谁在什么时点做了什么或说了什么，市场第一反应是什么，哪一个资产先动，谁随后跟进，哪一个市场拒绝跟随，随后暴露出什么矛盾。正文沿着行动、反应、后果向前走。段落可以推进事实或充分解释机制，不强制局面变化。没有真实人物时，就让政策动作、资金仓位或价格变化成为故事主角；绝不能虚构人物、会议、对白和现场细节。

深度来自把因果拆开讲透，不来自堆术语。每个重要结论都顺着“谁改变了什么变量—这个变量怎样影响资金或盈利—哪个资产为什么先反应”一步一步说明；只有当前选题确有跨市场关联时，才继续解释传到A股、港股或其他市场还缺什么条件。隔夜美股与次日A股、港股等非重叠交易时段不是同一消息的同步实验，必须先对齐指数、交易日、时区和信息截点；价格反向只能提出问题，不能自动证明单一原因。专业词第一次出现，立刻用中国观众熟悉的生活经验解释；类比必须比原概念更容易懂，并且全文最多保留一个真正有记忆点的原创意象。

开头兑现包装承诺，尽快说清事件和听下去的理由；异常、冲突或直接判断任选合适入口。中间有证据地讲透一个问题。结尾收住问题，自然说一次点赞关注。股民关系、转折、反方、验证条件、可复用方法、互动问题和泛化下期承接按需要选用，不强制补齐。

像真人一样说话：句子有长有短，关键处停一下，解释处允许展开；可以有克制的幽默、惊讶或不耐烦，但不能表演情绪。不要频繁使用“你可能以为”“真正的问题是”“更重要的是”“换句话说”“说白了”“这意味着什么”“不是A而是B”等AI常用接缝。转场优先依靠事件本身的新动作、新证据或价格变化，不靠修辞口号。

口播手艺要求：主调是有鲜明态度的财经评论员，带观众拆利益、预期和博弈。直接说谁干了什么、钱从哪里来、谁获益、谁承担代价，用具体动作解释机制；判断有对象、有证据。删除空转的“我更在意的是”“所以我的判断是”“我们再往深看一层”“得先说清楚”“经不起细算”等分析引导语，不用新的套话替换。自然使用人称，不设次数或位置配额。锋芒和幽默来自证据支持的利益错位与逻辑矛盾，可评论公司、机构或股民自己的想当然，不编造动机，不强塞段子。关键机制可以适量重复解释，不必每段制造转折。信源自然融入口播，不能写脚注、括号引用或网址。避免报告腔和抽象词堆叠，句子有长有短，听一遍能抓住主语和因果。

你不能和编辑对话，不能索要补充材料，不能说“如果你愿意”“把信息给我”“我可以继续完善”。现有证据不够时，删掉无依据细节、降低判断强度或写成观众可理解的待验证条件，但仍须一次性交付完整稿件。

最终只输出1000至3000个汉字的纯口播正文。不要标题、章节名、项目符号、舞台说明、写作解释、信源清单或Markdown。第一个字就是主播开口说的第一个字，最后一个字就是主播收尾说的最后一个字。"""

REVIEWER_SYSTEM = """你是独立于主笔的财经视频口播总编，也是一位擅长非虚构叙事的编辑。拿到选题、包装承诺、证据池和草稿后，先在心里把它读出声。它必须像一个有判断力的真人：事件型内容可沿时间线推进，原因分析型内容则围绕同一问题按解释力逐层下探；不是把财经研报分成自然段，也不是观点金句合集。不要写评语，直接交付局部修订后的完整逐字口播稿。

终审检查事实、逻辑、标题承诺和可朗读性，优先局部修正并保留自然好句。不要因缺少反转、反方、观察顺序、互动或下期承接重写全文。返回完整编辑后正文，不输出评语。

解释必须具体，听一遍能跟上；允许适量重复解释，不要求每段改变局面。转折如有使用必须有证据，不制造反方或悬念。

结尾自然请求一次点赞和关注金融巨子，收住问题即可。互动问题与下期承接可省略，不预告具体内容。

最终只输出1000至3000个汉字、可直接朗读的中文正文，不输出审查报告、标题、章节标记、列表或Markdown。"""

FINALIZER_SYSTEM = """你是短视频逐字口播稿交付编辑。输入内容是尚未达到交付标准的中间产物。你的唯一任务是把它彻底改写成博主坐在镜头前能自然说出口、观众只听一遍就能跟上的完整中文财经口播稿。不是文章，不是研报，不是新闻播报。不要讨论怎么改，不要输出计划，不要解释你做了什么。

硬性要求：1000至3000个汉字，纯口播正文，兑现当前题目与包装，事实有来源，重要判断有具体机制，不写买卖建议。开头说清事件和主要解释，中间讲透问题，结尾收住并点赞关注一次。其他叙事动作按题目需要选用，无固定段数和时间字数窗口。保留好句，只修必要问题。禁止Markdown、提纲、创作说明、索要资料和编造事实。

输出协议：只输出一组<口播正文>和</口播正文>标签，完整逐字稿放在标签中间。标签中间的第一个字必须是主播开口说的第一个字，不能再放标题或说明。"""


FINANCIAL_STORY_STYLE = """

“金融巨子”的独立叙事配方：吸收优秀中文财经内容的两类长处，但绝不模仿任何具体创作者的口头禅、固定句式、人设、自称或标志性表达。

把复杂机制拆成具体动作与成本，让观众看见谁收钱、付钱、借钱、涨价或关店。幽默只在证据支持的逻辑矛盾处自然出现，不设数量，不编造动机，不复制创作者原句。

交代关键玩家的动作与约束，必要时用有来源的历史比较解释价格，不空喊资本、周期与格局。

正文用连续解释推进：上一段动作产生的后果、尚未解释的数字或当事人的下一步，成为下一段入口。不强制制造新矛盾。不按第一、第二、第三或一是、二是、三是报分析点，不用三个原因或三个层面换皮。数字解释业务问题，不成排宣读指标；条款、排名、日期和季度可正常保留。

把机构、政府、央行和资金写成“有目标、有筹码、有约束的行动者”，但不得虚构心理活动。可以依据证据说某类资金面临再平衡、止损、汇率对冲或业绩压力，不能凭空说“华尔街慌了”“主力偷偷布局”“资本早有预谋”。

根据材料选择算账、行动与后果或预期差等走法，不规定推进次数。结尾收住问题并自然点赞关注一次；反转、反方、验证框架、互动和下期承接均按需要使用。
"""

FINANCIAL_STORY_REVIEW = """

结合本题检查解释是否具体、事实是否准确、利益关系是否有证据。利益故事、历史参照、幽默和转折只在有用时使用，不作为必交项目。发现问题局部修订，保留好句。
"""

COMPANY_EARNINGS_PRIORITY = """
财报稿遵循公司优先原则：如果核心事件是单一上市公司的财报、业绩预告、经营指引或资本开支更新，全文主角必须是该公司及其股票。主线依次回答盈利预期发生了什么变化、估值锚如何移动、财报后价格是否透支、未来上涨或下跌由哪些可验证信号决定。行业、供应链和跨市场联动只能在本股判断讲清后作为第二层影响，篇幅与重要性不得压过本股。只有多家公司数据形成共同证据时，才可升级为行业主线。
"""

COMMUNITY_DISCUSSION_STYLE = """
当创作底稿含雪球、X/Twitter、Reddit、微博等公开社区证据时，社区内容必须提供“人的思考增量”，而不是替代行情源。盘前早报、收盘播报、涨跌幅、创新高/新低、公告转述等纯客观事实，即使来自社交平台，也不得以“X上有人说”为由写入正文；这些事实回到公告、交易所、行情或高可信媒体确认。只有帖子包含原因解释、预期差、估值或产业逻辑、担忧与质疑、最强反方、情绪拥挤、验证条件等内容时，才可引用。引用时要讲清此人或此类投资者“如何解释、为什么这样判断”，随后给出主播是否认同、证据边界或还缺什么验证，不能只复述帖子结论。可以说“从目前能检索到的公开讨论看”“雪球上争议主要集中在”“X上的讨论更在意”，但必须说明或暗含样本边界。禁止写“全网都在说”“市场一致认为”，禁止虚构原帖、用户名、原话、点赞量和持仓。
"""

WRITER_SYSTEM += FINANCIAL_STORY_STYLE + COMPANY_EARNINGS_PRIORITY + COMMUNITY_DISCUSSION_STYLE
REVIEWER_SYSTEM += FINANCIAL_STORY_STYLE + FINANCIAL_STORY_REVIEW + COMPANY_EARNINGS_PRIORITY + COMMUNITY_DISCUSSION_STYLE
FINALIZER_SYSTEM += FINANCIAL_STORY_STYLE + FINANCIAL_STORY_REVIEW + COMPANY_EARNINGS_PRIORITY + COMMUNITY_DISCUSSION_STYLE
PERFORMANCE_LEARNING = """

前60秒只作效果目标：观众知道事件和主要解释，有继续听的理由。取消2/5/15秒窗口和固定字数补句，不用关键词判断口播质量。
"""
WRITER_SYSTEM += PERFORMANCE_LEARNING
REVIEWER_SYSTEM += PERFORMANCE_LEARNING
FINALIZER_SYSTEM += PERFORMANCE_LEARNING

def extract_script(text):
    match = re.search(r"<口播正文>\s*(.*?)\s*</口播正文>", text, re.S)
    return match.group(1).strip() if match else text.strip()


def normalize_oral_paragraphs(text, target=190, hard_limit=230):
    """Only changes paragraph breaks; it never rewrites or deletes model text."""
    source_paragraphs = [item.strip() for item in re.split(r"\n\s*\n", text) if item.strip()]
    normalized = []
    for paragraph in source_paragraphs:
        if len(re.sub(r"\s+", "", paragraph)) <= hard_limit:
            normalized.append(paragraph)
            continue
        units = [item.strip() for item in re.findall(r".*?[。！？!?；;](?:[”’」』])?|.+$", paragraph) if item.strip()]
        buffer = ""
        for unit in units:
            if len(re.sub(r"\s+", "", buffer + unit)) <= target:
                buffer += unit
                continue
            if buffer:
                normalized.append(buffer.strip())
                buffer = ""
            if len(re.sub(r"\s+", "", unit)) <= hard_limit:
                buffer = unit
                continue
            clauses = [item.strip() for item in re.findall(r".*?[，,：:、](?:[”’」』])?|.+$", unit) if item.strip()]
            for clause in clauses:
                if buffer and len(re.sub(r"\s+", "", buffer + clause)) > target:
                    normalized.append(buffer.strip())
                    buffer = ""
                buffer += clause
        if buffer:
            normalized.append(buffer.strip())
    return "\n\n".join(normalized)


def _closing_actions(text):
    ending = re.sub(r"\s+", "", text)[-420:]
    return {
        "like": bool(re.search(r"点赞|点(?:一|一下|个|个小)?赞|给.{0,6}一个赞", ending)),
        "follow": bool(re.search(r"(?:关注.{0,10}(?:金融巨子|账号|我)|(?:金融巨子|这个账号).{0,8}关注|点个关注|记得关注)", ending)),
    }


def ensure_closing_cta(text):
    """Preserve wording; only remove a proven duplicate legacy fallback."""
    clean = text.strip()

    # Remove the legacy fallback when a preceding, complete CTA already exists.
    fallback = "如果这期分析对你有帮助，记得点赞、关注金融巨子，咱们下期继续聊最新的市场变化。"
    if clean.endswith(fallback):
        prefix = clean[:-len(fallback)].rstrip()
        if all(_closing_actions(prefix).values()):
            clean = prefix

    return clean


def delivery_problems(text):
    compact_length = len(re.sub(r"\s+", "", text))
    problems = []
    if compact_length < 1000:
        problems.append(f"正文不足1000字（当前约{compact_length}字）")
    if compact_length > 3000:
        problems.append(f"正文超过3000字（当前约{compact_length}字）")
    if re.search(r"(?m)^\s*(#{1,6}\s|```|[-*+]\s+|\d+[.、)]\s*)", text):
        problems.append("包含Markdown标题、代码围栏或列表")
    if re.search(r"(?m)^\s*(写作思路|创作思路|核心判断|情绪弧线|留存单元|内容大纲|审稿意见|修改说明|成稿策略|结构设计)\s*[:：]", text):
        problems.append("包含提纲或审稿说明")
    if re.search(r"^\s*(下面|以下)(是|为).{0,20}(口播|正文|文稿|成稿)", text):
        problems.append("包含交付前言")
    if re.search(r"你愿意的话|如果你愿意|把.{0,20}(补给我|发给我|告诉我)|请.{0,12}(提供|补充|告诉)|需要你.{0,12}(提供|补充)|我可以.{0,18}(继续|再帮|进一步)|等你.{0,12}(回复|补充)|你只需要.{0,12}(提供|告诉)", text):
        problems.append("仍在与编辑对话或索要补充信息，没有直接交付口播稿")
    paragraphs = [item.strip() for item in re.split(r"\n\s*\n", text) if item.strip()]
    if paragraphs and max(len(re.sub(r"\s+", "", item)) for item in paragraphs) > 240:
        problems.append("存在超过240字的超长段落，不适合照读")
    sentences = [item for item in re.split(r"[。！？]", text) if re.sub(r"\s+", "", item)]
    if sentences:
        average_sentence = compact_length / len(sentences)
        long_sentences = sum(1 for item in sentences if len(re.sub(r"\s+", "", item)) > 60)
        if average_sentence > 58:
            problems.append(f"平均句长约{average_sentence:.0f}字，明显是文章体")
        if long_sentences > max(3, len(sentences) // 4):
            problems.append("超过60字的长句过多，主播难以换气")
    formal_markers = re.findall(r"综上所述|值得注意的是|从.{0,12}(角度|维度)来看|该事件(表明|说明)|首先|其次|最后", text)
    if len(formal_markers) >= 3:
        problems.append("报告体连接词过多")
    if re.search(r"我更在意的(?:是)?|(?:所以)?我的判断是|我们再往深看一层|得先说清楚|经不起细算", text):
        problems.append("存在空转的分析引导语，应直接说具体事实、动作或判断依据")
    ai_connectors = re.findall(r"你可能以为|真正的问题是|更重要的是|换句话说|说白了|这意味着什么|不是.{0,22}而是", text)
    if len(ai_connectors) >= 5:
        problems.append("AI常用转折和对称句式重复过多")
    ending = re.sub(r"\s+", "", text)[-420:]
    if not _closing_actions(text)["like"]:
        problems.append("结尾没有直接请观众点赞")
    if not re.search(r"(?:关注.{0,10}(?:金融巨子|账号|我)|(?:金融巨子|这个账号).{0,8}关注|点个关注|记得关注)", ending):
        problems.append("结尾没有直接请观众关注并说明继续跟踪的理由")
    if len(re.findall(r"点赞|点(?:一|一下|个|个小)?赞|给.{0,6}一个赞", ending)) > 1:
        problems.append("结尾重复引导点赞")
    if len(re.findall(r"关注(?:金融巨子|账号|我)|关注.{0,8}(?:金融巨子|账号|我)", ending)) > 1:
        problems.append("结尾重复引导关注")
    if re.search(r"(?:你|大家).{0,12}(?:持有|成本价|买入|卖出|加仓|减仓|抄底|上车)", ending):
        problems.append("结尾互动在询问观众持仓或买卖计划")
    return problems


def has_outline_enumeration(text):
    """Detect spoken outline labels, preserving dates, ranks and quarters."""
    labels = re.findall(r"(?:^|[\n。！？；])\s*(?:第(?:[一二三四五六七八九十]+|\d+)(?:步|点|项|条|个(?:原因|方面|问题|信号|观察点|步骤))\s*[、，,:：]?|第[一二三四五六七八九十]+[、，,:：]|[一二三四五六七八九十]是[、，,:：]?|首先[、，,:：]|其次[、，,:：]|最后[、，,:：])", text)
    return len(labels) >= 2


def opening_performance_problems(text):
    """Review opening semantically; no timed keyword quota."""
    return []


def _parse_evidence_time(value):
    raw = str(value or "").strip().replace("Z", "+00:00")
    if not raw:
        return None
    if re.fullmatch(r"\d{10}(?:\.\d+)?|\d{13}", raw):
        try:
            number = float(raw)
            return datetime.fromtimestamp(number / 1000 if number > 10_000_000_000 else number, timezone.utc)
        except (ValueError, OverflowError, OSError):
            return None
    raw = re.sub(r"[年/]", "-", raw).replace("月", "-").replace("日", "").strip()
    raw = re.sub(r"\s*(?:北京时间|中国标准时间|CST)\s*$", "+08:00", raw)
    try:
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone(timedelta(hours=8)))
        return parsed.astimezone(timezone.utc)
    except ValueError:
        try:
            parsed = parsedate_to_datetime(raw)
            return parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone(timedelta(hours=8))).astimezone(timezone.utc)
        except (ValueError, TypeError, OverflowError):
            return None


def _url_intrinsic_date(value):
    try:
        path = urlparse(str(value or "")).path
        match = re.search(r"(?:^/|/)(20\d{2})[-_/]?(0[1-9]|1[0-2])[-_/]?([0-2]\d|3[01])(?:/|[-_.]|$)", path)
        if not match:
            return None
        return datetime(int(match.group(1)), int(match.group(2)), int(match.group(3)), tzinfo=timezone(timedelta(hours=8))).astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def build_fresh_fact_corpus(topic_context, diagnostics=None):
    """Only recent, traceable source text may authorize market numbers."""
    now = datetime.now(timezone.utc)
    accepted = []
    rejected = []
    for item in topic_context.get("evidence", []) if isinstance(topic_context, dict) else []:
        if not isinstance(item, dict):
            continue
        raw_time = item.get("publishedAt") or item.get("published_time") or item.get("publish_time") or item.get("date")
        published = _parse_evidence_time(raw_time)
        intrinsic = _url_intrinsic_date(item.get("url"))
        effective = intrinsic or published
        reason = ""
        if item.get("social"):
            reason = "社区观点不是行情事实源"
        elif not str(item.get("snippet") or item.get("body") or item.get("content") or "").strip():
            reason = "缺少证据正文或摘要"
        elif not str(item.get("url") or "").startswith(("http://", "https://")):
            reason = "缺少可追溯来源链接"
        elif not effective:
            reason = "发布时间缺失或格式无法识别"
        elif effective > now + timedelta(hours=2):
            reason = "发布时间在未来"
        elif now - effective > timedelta(hours=72):
            reason = "来源已超过72小时"
        elif intrinsic and published and abs((intrinsic - published).total_seconds()) > 72 * 3600:
            reason = "链接日期与标注发布时间冲突"
        if reason:
            rejected.append(item.get("title") or item.get("url") or "无标题证据")
            if diagnostics is not None:
                diagnostics.append({"title": item.get("title") or "无标题证据", "url": item.get("url") or "", "publishedAt": raw_time or "", "reason": reason})
            continue
        accepted.append(" ".join(str(value) for value in (item.get("title", ""), item.get("snippet") or item.get("body") or item.get("content") or "", effective.isoformat(), item.get("site", ""), item.get("url", ""))))
    return "\n".join(accepted), rejected


def factual_number_problems(text, topic_context):
    corpus, rejected = build_fresh_fact_corpus(topic_context)
    normalized_corpus = re.sub(r"\D", "", corpus)
    problems = []
    sensitive = re.compile(r"人民币|离岸|在岸|汇率|美元|日元|欧元|股价|指数|收益率|利率|基点|市值|成交|涨|跌|新高|新低|最高|最低|收盘|开盘")
    claim_pattern = re.compile(r"\d+(?:\.\d+)?(?:%|％)?|[一二三四五六七八九十两]+年(?:半)?")
    for sentence in re.split(r"(?<=[。！？])", text):
        if not sensitive.search(sentence):
            continue
        claims = claim_pattern.findall(sentence)
        for claim in claims:
            digits = re.sub(r"\D", "", claim)
            grounded = claim in corpus or (digits and digits in normalized_corpus)
            if not grounded:
                excerpt = re.sub(r"\s+", "", sentence)[:90]
                problems.append(f"行情数字或期限“{claim}”没有出现在任何72小时内的原始证据中（{excerpt}）")
    if rejected and not corpus and claim_pattern.search(text) and sensitive.search(text):
        problems.append("本项目没有可用于核验行情数字的近期原始证据，禁止写入具体报价、涨跌幅、日期或历史极值")
    return list(dict.fromkeys(problems))


def completion(client, model, system, user, receipts=None):
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    for attempt in range(2):
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=6000,
            extra_body={"thinking": {"type": "disabled"}},
        )
        text = response.choices[0].message.content or ""
        if receipts is not None:
            usage = getattr(response, "usage", None)
            receipts.append({
                "responseId": getattr(response, "id", "") or "",
                "requestedModel": model,
                "actualModel": getattr(response, "model", "") or model,
                "inputTokens": getattr(usage, "prompt_tokens", None) if usage else None,
                "outputTokens": getattr(usage, "completion_tokens", None) if usage else None,
            })
        if text.strip():
            return text.strip()
        messages = messages + [{
            "role": "user",
            "content": "上一次响应正文为空。不要输出思考过程，立即直接输出完整的最终口播正文。",
        }]
    raise RuntimeError("DeepSeek 连续两次返回空正文，本次稿件未写入。")


def generate_script(request_data):
    api_key = str(request_data.get("apiKey", "")).strip()
    model = str(request_data.get("model", "deepseek-v4-pro")).strip().lower() or "deepseek-v4-pro"
    topic = str(request_data.get("topic", "")).strip()
    research = [
        item for item in (request_data.get("research") or [])
        if isinstance(item, dict) and item.get("key") not in {"数据迭代", "策略约束"}
    ]
    packaging = request_data.get("packaging") or {}
    topic_context = dict(request_data.get("topicContext") or {})
    packaging_options = request_data.get("packagingOptions") or []
    workflow_context = request_data.get("workflowContext") or {}
    strategy = _sanitize_strategy(request_data.get("strategyProfile") or {})
    if not api_key or not topic or not isinstance(research, list):
        return {"ok": False, "status": 400, "error": "缺少 DeepSeek API Key、选题或研究底稿。"}

    # Writing consumes the frozen research evidence only. Social retrieval is
    # performed and persisted in the workshop's research stage.
    interpretive_pattern = re.compile(
        r"我认为|我觉得|在我看来|因为|原因|逻辑|解释|预期|担心|质疑|分歧|争论|风险|估值|定价|资本开支|需求|供给|周期|反映|意味着|看多|看空|但是|不过|反而|未必|除非|如果|可能|或许|为什么|bullish|bearish|because|expect|concern|thesis|valuation|priced.?in",
        re.I,
    )
    frozen_social = [
        item for item in (topic_context.get("evidence") or [])
        if isinstance(item, dict) and item.get("social")
        and interpretive_pattern.search(f"{item.get('title', '')} {item.get('snippet', '')}")
    ]
    social_lines = []
    for item in frozen_social[:12]:
        platform = item.get("site") or ("雪球" if item.get("platform") == "xueqiu" else "X")
        author = item.get("author") or "公开用户"
        snippet = re.sub(r"\s+", " ", str(item.get("snippet") or "")).strip()[:500]
        social_lines.append(
            f"{platform}｜{author}｜{item.get('publishedAt') or '时间未标注'}｜{snippet}｜{item.get('url') or '无链接'}"
        )
    social_corpus = "\n".join(social_lines)
    social_channels = topic_context.get("socialEvidence") or {}

    def community_usage_problems(script):
        if not frozen_social:
            return []
        platform_reference = r"雪球|X上|X的|公开讨论|社区讨论|投资者.{0,8}(争论|分歧|讨论)"
        human_reasoning = r"认为|解释|原因|逻辑|预期|担心|质疑|分歧|争论|风险|估值|定价|未必|反方|看多|看空|拥挤"
        if re.search(rf"(?:{platform_reference}).{{0,180}}(?:{human_reasoning})|(?:{human_reasoning}).{{0,180}}(?:{platform_reference})", script, re.I | re.S):
            return []
        return ["研究底稿含有观点型社区证据，但正文只提平台或复述客观事实，没有呈现人的原因解释、预期、质疑或反方"]

    evidence = "\n\n".join(
        f"{item.get('key', '证据')}｜{item.get('title', '')}\n{item.get('body', '')}"
        for item in research if isinstance(item, dict)
    )
    raw_event_context = json.dumps(topic_context, ensure_ascii=False, indent=2)
    fact_diagnostics = []
    fresh_fact_corpus, rejected_fact_sources = build_fresh_fact_corpus(topic_context, fact_diagnostics)
    if not fresh_fact_corpus:
        return {
            "ok": False,
            "status": 422,
            "error": "当前项目暂无可用于写稿的72小时内事实证据。" + ("；".join(f"{row['title'][:35]}：{row['reason']}（时间：{row['publishedAt'] or '未提供'}）" for row in fact_diagnostics[:6]) if fact_diagnostics else "项目未携带原始证据列表。") + "。请核对底稿来源；可为当前项目补充近期来源，不必删除项目或重建稿件。社区观点不能代替事实来源。",
            "evidenceDiagnostics": fact_diagnostics,
        }
    workflow_brief = json.dumps(workflow_context, ensure_ascii=False, indent=2)
    alternative_packaging = json.dumps(packaging_options, ensure_ascii=False, indent=2)
    brief = (
        "【账号与交付目标】\n"
        "账号：金融巨子。目标受众是关注A股、港股、美股、外汇、债券和大宗商品联动的中文投资者。内容必须提供观点和判断，不荐股。\n"
        f"工作流要求：\n{workflow_brief}\n\n"
        "【抖音真实数据形成的最新迭代策略】\n"
        "它是历史样本产生的可证伪策略，不是事实来源。只采用与本题证据和包装承诺相容的部分，不能为了迎合历史爆款改变当前事件主体，也不能引用后台数据给观众。\n"
        f"{json.dumps({'dataBoundary': strategy.get('dataBoundary', ''), 'researchDirectives': strategy.get('researchDirectives', []), 'scriptDirectives': strategy.get('scriptDirectives', []), 'avoid': strategy.get('avoid', [])}, ensure_ascii=False, indent=2)}\n\n"
        "【已经锁定的选题】\n"
        f"{topic}\n\n"
        "【热点扫描保留下来的原始事件上下文】\n"
        "这里包含事件摘要、触发因素、时间新鲜度、市场范围、热度和账号匹配评分、硬门结果、来源数量、社交信号以及证据标题/站点/链接。"
        "评分只用于判断选题重要性，不能当作对观众宣读的市场事实；证据链接和标题用于约束事实，不要在正文堆网址。\n"
        f"{raw_event_context}\n\n"
        "【研究底稿冻结的社区讨论样本】\n"
        "以下内容是研究阶段已经保存进当前项目、且通过观点增量门槛的雪球和X公开帖子。写稿阶段不得另行搜索或替换证据。"
        "若本区非空，正文必须至少自然使用一处人的原因解释、预期、质疑或反方，并明确平台或样本边界；不能只报讨论数量，不能复述客观行情冒充社区洞察，也不能把帖子观点当成事实。\n"
        f"{social_corpus or '本次没有取得可用的原生社区帖子，禁止虚构雪球或X观点。'}\n"
        f"渠道诊断：{json.dumps(social_channels, ensure_ascii=False)}\n\n"
        "【允许引用具体数字的近期事实账本】\n"
        "只有下面逐字出现的报价、涨跌幅、日期、基点和历史极值才可进入正文。事实账本为空时，禁止自行补充任何行情数字。\n"
        f"{fresh_fact_corpus or '空：当前没有包含正文摘要与可信发布时间的近期原始证据。'}\n"
        f"已排除的无日期、过期或日期冲突来源：{json.dumps(rejected_fact_sources, ensure_ascii=False)}\n\n"
        "【当前已经选定的包装承诺】\n"
        "开头兑现当前标题与包装承诺，不能换成另一事件。尽快说清事件及主要解释，不按固定字数窗口补句；如果标题承诺多个问题，逐一回答但用连续口播衔接，不朗读提纲序号。\n"
        f"标题：{packaging.get('title', topic)}\n"
        f"Hook方向：{packaging.get('hook', '')}\n"
        f"核心矛盾：{packaging.get('conflict', '')}\n"
        f"标题类型：{packaging.get('type', '')}\n"
        f"受众动机：{packaging.get('motive', '')}\n"
        f"搜索关键词：{packaging.get('keyword', '')}\n"
        f"封面分工：{packaging.get('coverMode', '')}\n\n"
        "【包装阶段产生的其他方案，仅用于理解取舍，不能混写多个标题承诺】\n"
        f"{alternative_packaging}\n\n"
        "【动态创作底稿】\n"
        "这些卡片分为事实硬门、写前决策和可选弹药，不是文章结构，也不要求全部使用。只选能被原始事件上下文支持、且真正服务于唯一核心判断的内容；任何空泛、错配、矛盾、重复或无来源内容必须舍弃。\n"
        f"{evidence}\n\n"
        "约束发生冲突时，依次服从可核验事实与安全边界、当前选题、当前包装承诺、当前写稿Skill中的合规/事实/输出协议硬规则、当前动态研究底稿的本题判断、抖音数据形成的动态策略、通用叙事习惯。动态策略只优化选题偏好、信息顺序、Hook和叙事实验，不能推翻事实核验、禁止荐股、纯口播输出、长度范围、当前事件主体和标题承诺。旧模板、默认案例、固定时间线、固定段数和通用跨市场要求不得覆盖当前底稿。写作前必须在内部完成：从原始证据确认事件主体和时间，选择唯一核心判断；仅在主题确有跨市场关联时确定传导链及其成立条件；核对标题承诺。然后直接写成篇口播，不要把上述内部工作输出。"
    )
    try:
        receipts = []
        current_skill = WRITING_SKILL_PATH.read_text(encoding="utf-8") if WRITING_SKILL_PATH.is_file() else ""
        style_reference = WRITING_SKILL_PATH.parent / "references" / "conversational-finance.md"
        if style_reference.is_file():
            current_skill += "\n\n" + style_reference.read_text(encoding="utf-8")
        brief += "\n\n当前表达规则覆盖旧底稿中的人称配额与旧口语示例：不要求开头出现咱们，不要求至少两次我；删除空转的分析引导语，直接讲具体事实、动作及其理由。终审优先局部修正事实、逻辑断口和难读句，保留已经自然的表达，不为统一风格重写好句。"
        writer_system = WRITER_SYSTEM + "\n\n以下是本项目当前生效的口播稿 Skill，逐条执行：\n" + current_skill
        reviewer_system = REVIEWER_SYSTEM + "\n\n以下是本项目当前生效的口播稿 Skill，逐条终审：\n" + current_skill
        finalizer_system = FINALIZER_SYSTEM + "\n\n以下是本项目当前生效的口播稿 Skill，逐条修复：\n" + current_skill
        brief += "\n\n当前结构规则覆盖旧底稿和动态策略中的叙事配额：开头说清事件和听下去的理由、中间讲透问题、结尾收住并点赞关注一次。其余动作按需要选用，无固定时间字数窗口，不因缺项重写全文。"
        closing_style = "\n收尾用自然请求，允许点个赞、点个关注等表达，不要求连续出现点赞二字。不要写如果本期把某逻辑讲透了、如果我说明白了等自我验收和自夸铺垫；不要用分号接孤立的点赞、关注命令。分析收住后短短邀请即可，不复述整段选题，不强求宏大关注理由。措辞随语境变化，不套固定结尾。"
        writer_system += closing_style
        reviewer_system += closing_style
        finalizer_system += closing_style
        brief += closing_style
        narration_style = "\n验证条件同样属于口播，不写第一步、第二步、第三步或第一个信号等观察清单。按本题证据讲清哪些疑问尚未解决，必要时串起其关系；并列事项可以自然并列，不编造因果，也不用数字路标。不强行以接下来要看三件事收尾。"
        writer_system += narration_style
        reviewer_system += narration_style
        brief += narration_style
        client = openai.OpenAI(
            api_key=api_key,
            base_url="https://api.deepseek.com",
            timeout=httpx.Timeout(240.0, connect=30.0),
            max_retries=2,
        )
        draft = completion(client, model, writer_system, brief, receipts)
        final_script = completion(client, model, reviewer_system, f"{brief}\n\n主笔草稿：\n{draft}", receipts)
        final_script = ensure_closing_cta(normalize_oral_paragraphs(extract_script(final_script)))
        stages = ["主笔创作", "独立终审编辑"]
        if has_outline_enumeration(final_script):
            final_script = completion(client, model, reviewer_system,
                f"{brief}\n\n待编辑正文：\n{final_script}\n\n正文仍在逐项报提纲。仅改相关段落的连接：围绕已有证据，用动作、后果或同一业务问题衔接，不能只删序号，不能补造因果。保留事实、判断、自然好句和完整收尾。输出完整正文。", receipts)
            final_script = ensure_closing_cta(normalize_oral_paragraphs(extract_script(final_script)))
            stages.append("提纲式转场局部编辑")
        problems = opening_performance_problems(final_script) + delivery_problems(final_script) + factual_number_problems(final_script, topic_context) + community_usage_problems(final_script)
        if has_outline_enumeration(final_script):
            problems.append("仍有连续提纲式序号，建议局部编辑转场")
        return {
            "ok": True,
            "script": final_script,
            "model": model,
            "warning": f"编辑提醒（不阻止使用）：{'；'.join(problems)}" if problems else "",
            "warnings": problems,
            "stages": stages,
            "provenance": {
                "provider": "DeepSeek API",
                "endpoint": "https://api.deepseek.com/chat/completions",
                "callCount": len(receipts),
                "receipts": receipts,
            },
        }
    except openai.APIStatusError as error:
        return {"ok": False, "status": error.status_code, "error": f"DeepSeek {error.status_code}：{error.message}"}
    except openai.APITimeoutError:
        return {"ok": False, "status": 504, "error": "DeepSeek 写稿超过4分钟仍未返回。"}
    except openai.APIConnectionError as error:
        return {"ok": False, "status": 502, "error": f"连接 DeepSeek 失败：{error}；底层原因：{error.__cause__!r}"}
    except Exception as error:
        return {"ok": False, "status": 502, "error": f"DeepSeek Python 调用失败：{type(error).__name__}: {error}"}

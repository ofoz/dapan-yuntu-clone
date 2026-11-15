#!/usr/bin/env python3
"""大盘云图复刻版 —— 本地行情聚合（腾讯行情源，不依赖 dpyt.org）。

设计说明：
  * 股票池与板块归属来自打包快照 assets/data/all-day.js（code/名称/一级板块/
    二级板块/交易所/流通市值），作为「骨架」；
  * 实时行情用腾讯批量接口 https://qt.gtimg.cn/q=sh600519,sz000001,... 拉取，
    单次可带 900 只，全市场 5579 只 ≈ 7 批；
  * 腾讯单条记录已同时包含「当日 / 近 5 日 / 近 20 日 / 年初至今」四个周期的
    涨跌幅（字段索引 32 / 63 / 70 / 62，已用日 K 逐只校验），因此一次抓取即可
    服务前端的日/周/月/年四个周期；
  * 输出结构与 dpyt.org 的 /api/heatmap/* 完全同构，前端一行不用改。

字段索引（腾讯 v_xxx="..." 按 ~ 分割，0 基）：
    1 名称   2 代码   3 现价   4 昨收   30 行情时间(yyyymmddHHMMSS)
    32 当日涨跌幅%   37 成交额(万元)   44 流通市值(亿元)
    62 年初至今%   63 近 5 日%   70 近 20 日%
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "assets", "data")
CACHE_DIR = os.path.join(ROOT, "cache")

QT_URL = "https://qt.gtimg.cn/q="
# 日K 接口：返回 [日期,开,收,高,低,成交量(手),{},换手率?,成交额(万元),...]
# 第 9 个字段(索引 8) 实测为成交额（万元），已与 qt 实时字段 37 交叉校验。
KLINE_URL = "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=%s,day,,,%d,qfq"
MARKET_INDEX_SYMBOLS = ("sh000001", "sz399107")   # 沪市 / 深市，成交额合计≈两市总额
BJ_PROXY_SYMBOL = "bj899050"                       # 北证50，按比例折算北交所份额
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
BATCH = 900           # 单次请求携带的代码数（实测上限约 900~950）
LIVE_VALUE = os.environ.get("DPYT_LIVE_VALUE", "") not in ("", "0", "false", "no")
# LIVE_VALUE=1 时面积直接用腾讯实时流通市值；默认用「快照权重×实时价格/快照价格」，
# 保持与原站相同的股本口径（同一交易日下逐像素一致性明显更好）。
CN_TZ = timezone(timedelta(hours=8))

# 市场 -> 指数（腾讯代码，None 表示该市场无对应指数，用成分股加权）
MARKET_INDEX = {
    "all": ("sz399317", "国证Ａ指"),
    "sse": ("sh000001", "上证指数"),
    "szse": ("sz399107", "深证Ａ指"),
    "hs300": ("sh000300", "沪深300"),
    "zza50": (None, "中证A50"),
    "zza500": ("sh000510", "中证A500"),
    "main": (None, "A 股主板"),
    "cyb": ("sz399006", "创业板指"),
    "kcb": ("sh000680", "科创综指"),
}
MARKET_LABEL = {
    "all": "A 股全图", "sse": "上证 A 股", "szse": "深证 A 股",
    "hs300": "沪深 300", "zza50": "中证 A50", "zza500": "中证 A500",
    "main": "A 股主板", "cyb": "创业板", "kcb": "科创板",
}
PERIOD_FIELD = {"day": "pctDay", "week": "pctWeek", "month": "pctMonth", "year": "pctYear"}

# ---------------------------------------------------------------- 股票池骨架

_universe_lock = threading.RLock()   # RLock：universe() 内部还会调用 period_index()
_universe = None          # list[dict]: code/name/boardName/subBoardName/exchange/staticValue
_members = {}             # market -> list[code]（日周期口径，旧版池 5579 只）
_members_fresh = {}       # market -> list[code]（周/月/年口径，新版池 5582 只）
_period_index = None      # assets/data/period-index.json


def period_index():
    """线上 dpyt 的日周期与周/月/年周期用的不是同一版股票池：

    - 日周期：5579 只（旧版快照）
    - 周/月/年：5582 只（新版池，多 3 只新股，且沪深300/中证A500/A50 成分已更新）

    该文件从线上 treemap 一次性提取（extra=新增股票，indexSets=新版指数成分），
    使非日周期与线上完全一致，同时不影响日周期的逐像素保真。
    """
    global _period_index
    with _universe_lock:
        if _period_index is None:
            path = os.path.join(DATA_DIR, "period-index.json")
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    _period_index = json.load(fh)
            except Exception:
                _period_index = {"extra": [], "indexSets": {}}
        return _period_index


def _read_dataset(key: str):
    """从打包的 assets/data/<key>.js 里取出 window.DPYT_DATA["<key>"] 的 JSON。"""
    path = os.path.join(DATA_DIR, key + ".js")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    marker = 'window.DPYT_DATA["%s"]=' % key
    idx = text.find(marker)
    if idx < 0:
        return None
    return json.loads(text[idx + len(marker):].strip().rstrip(";"))


def universe():
    """股票池（首次调用时从 all-day.js 建立，之后复用）。"""
    global _universe, _members, _members_fresh
    with _universe_lock:
        if _universe is not None:
            return _universe
        ds = _read_dataset("all-day")
        if not ds:
            raise RuntimeError("缺少 assets/data/all-day.js，无法建立股票池")
        rows = []
        for board in ds["nodes"]:
            for st in board["children"]:
                rows.append({
                    "code": st["code"],                       # 601138.SH
                    "name": st["name"],
                    "boardName": st.get("boardName") or board["name"],
                    "subBoardName": st.get("subBoardName") or "其他",
                    "exchange": st.get("exchange") or st["code"].split(".")[-1],
                    "staticValue": float(st.get("value") or 0),
                    "staticPrice": float(st.get("price") or 0),
                })
        # 日周期口径的指数成分股集合（来自打包数据集）
        idx_sets = {}
        for mk in ("hs300", "zza50", "zza500"):
            d = _read_dataset(mk + "-day")
            if d:
                idx_sets[mk] = {c["code"] for b in d["nodes"] for c in b["children"]}
        m = {"all": [r["code"] for r in rows]}
        m["sse"] = [r["code"] for r in rows if r["exchange"] == "SH"]
        m["szse"] = [r["code"] for r in rows if r["exchange"] == "SZ"]
        for mk, s in idx_sets.items():
            m[mk] = [r["code"] for r in rows if r["code"] in s]
        m["main"] = [r["code"] for r in rows if re.match(r"^(600|601|603|605|000|001|002|003)", r["code"])]
        m["cyb"] = [r["code"] for r in rows if r["code"][:3] == "300"]
        m["kcb"] = [r["code"] for r in rows if r["code"][:3] == "688"]
        _members = m

        # 周/月/年口径：并入 period-index.json 里的新版池（多 3 只）与新版指数成分
        pi = period_index()
        extra = []
        for e in pi.get("extra") or []:
            extra.append({
                "code": e["code"],
                "name": e["name"],
                "boardName": e.get("boardName") or "其他",
                "subBoardName": e.get("subBoardName") or "其他",
                "exchange": e["code"].split(".")[-1],
                "staticValue": 0.0,      # 新版池没有旧口径静态权重，非日周期用实时市值
                "staticPrice": 0.0,
                "extra": True,
            })
        rows = rows + extra
        fresh = {"all": [r["code"] for r in rows]}
        fresh["sse"] = [r["code"] for r in rows if r["exchange"] == "SH"]
        fresh["szse"] = [r["code"] for r in rows if r["exchange"] == "SZ"]
        sets = pi.get("indexSets") or {}
        for mk in ("hs300", "zza50", "zza500"):
            s = sets.get(mk)
            if s:
                pool = set(s)
                fresh[mk] = [r["code"] for r in rows if r["code"] in pool]
        fresh["main"] = [r["code"] for r in rows if re.match(r"^(600|601|603|605|000|001|002|003)", r["code"])]
        fresh["cyb"] = [r["code"] for r in rows if r["code"][:3] == "300"]
        fresh["kcb"] = [r["code"] for r in rows if r["code"][:3] == "688"]
        _members_fresh = fresh

        _universe = rows
        return rows


def members(market: str, period: str = "day"):
    """市场成员列表。日周期用旧版池（与原站日周期逐像素一致），
    周/月/年用新版池（与原站非日周期一致）。"""
    universe()
    key = "all" if market == "watch" else market
    if period != "day":
        return _members_fresh.get(key) or _members_fresh["all"]
    return _members.get(key) or _members["all"]


def _by_code():
    universe()
    return {r["code"]: r for r in _universe}


def _qt_symbol(code: str) -> str:
    """601138.SH -> sh601138"""
    num, _, ex = code.partition(".")
    return {"SH": "sh", "SZ": "sz", "BJ": "bj"}.get(ex.upper(), "sz") + num


def _stable_id(name: str) -> str:
    return "%08x" % (zlib.crc32(name.encode("utf-8")) & 0xFFFFFFFF)


# ---------------------------------------------------------------- 行情抓取

SNAPSHOT = {
    "quotes": {},        # code -> {name, price, pctDay, pctWeek, pctMonth, pctYear, turnover, floatValue, time}
    "indices": {},       # qt symbol -> {name, price, pct...}
    "updatedAt": None,   # ISO8601
    "tradeDate": None,
    "fetchedAt": 0.0,
    "error": None,
    "count": 0,
}
_snap_lock = threading.Lock()
_fetch_lock = threading.Lock()


def _http_get(url: str, timeout: float = 20.0) -> bytes:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": "https://gu.qq.com/",
        "Accept": "*/*",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _num(parts, i, default=None):
    try:
        v = parts[i].strip()
        return float(v) if v not in ("", "-", "null") else default
    except (IndexError, ValueError):
        return default


def _parse_qt(text: str) -> dict:
    """把腾讯接口返回的多行文本解析成 {qt符号: 记录}。"""
    out = {}
    for line in text.split("\n"):
        if '="' not in line:
            continue
        head, _, rest = line.partition('="')
        sym = head.split("=")[0].strip()
        if sym.startswith("v_"):
            sym = sym[2:]
        body = rest.rsplit('";', 1)[0]
        p = body.split("~")
        if len(p) < 45:
            continue
        rec = {
            "name": p[1],
            "code": p[2],
            "price": _num(p, 3, 0.0),
            "prevClose": _num(p, 4, 0.0),
            "time": p[30],
            "pctDay": _num(p, 32, 0.0),
            "turnover": (_num(p, 37, 0.0) or 0.0) * 1e4,      # 万元 -> 元
            "floatValue": (_num(p, 44, 0.0) or 0.0) * 1e8,    # 亿元 -> 元
            "pctYear": _num(p, 62, None),
            "pctWeek": _num(p, 63, None),
            "pctMonth": _num(p, 70, None),
        }
        out[sym] = rec
    return out


def _fetch_quotes(symbols):
    """按批拉取行情（并发 3，腾讯对并发不敏感，实测 900 只/批约 0.6s）。"""
    batches = [symbols[i:i + BATCH] for i in range(0, len(symbols), BATCH)]
    quotes = {}
    errors = []

    def one(chunk):
        url = QT_URL + ",".join(chunk)
        for attempt in range(3):
            try:
                return _parse_qt(_http_get(url).decode("gbk", errors="ignore"))
            except Exception as exc:                       # 网络抖动重试
                if attempt == 2:
                    errors.append(str(exc))
                else:
                    time.sleep(0.8 * (attempt + 1))
        return {}

    with ThreadPoolExecutor(max_workers=3) as pool:
        for res in pool.map(one, batches):
            quotes.update(res)
    return quotes, errors


def _fmt_qt_time(raw: str):
    """20261113161455 -> (ISO8601, 'YYYY-MM-DD')"""
    if raw and len(raw) >= 14 and raw[:8].isdigit():
        try:
            dt = datetime.strptime(raw[:14], "%Y%m%d%H%M%S").replace(tzinfo=CN_TZ)
            return dt.isoformat(), dt.strftime("%Y-%m-%d")
        except ValueError:
            pass
    now = datetime.now(CN_TZ)
    return now.isoformat(timespec="seconds"), now.strftime("%Y-%m-%d")


def is_trading_time() -> bool:
    now = datetime.now(CN_TZ)
    if now.weekday() >= 5:
        return False
    hm = now.hour * 100 + now.minute
    return 915 <= hm <= 1135 or 1255 <= hm <= 1505


def refresh() -> dict:
    """拉一次全市场 + 指数行情，写入 SNAPSHOT。返回快照。"""
    global SNAPSHOT
    rows = universe()
    symbols = [_qt_symbol(r["code"]) for r in rows]
    idxsyms = [v[0] for v in MARKET_INDEX.values() if v[0]]
    t0 = time.time()
    with _fetch_lock:
        quotes, errors = _fetch_quotes(symbols)
        idx_quotes = {}
        try:
            idx_quotes = _parse_qt(_http_get(QT_URL + ",".join(idxsyms)).decode("gbk", errors="ignore"))
        except Exception as exc:
            errors.append(str(exc))
    stamp, trade_day = _fmt_qt_time(next((q["time"] for q in quotes.values() if q.get("time")), ""))
    with _snap_lock:
        SNAPSHOT = {
            "quotes": quotes,
            "indices": idx_quotes,
            "updatedAt": stamp,
            "tradeDate": trade_day,
            "fetchedAt": time.time(),
            "error": ("; ".join(errors[:3]) if errors else None),
            "count": len(quotes),
            "elapsed": round(time.time() - t0, 2),
        }
    _record_turnover(trade_day)
    return SNAPSHOT


def snapshot(ttl: float | None = None) -> dict:
    """取当前快照，必要时刷新（交易时段 8s，其余 300s）。"""
    with _snap_lock:
        snap = dict(SNAPSHOT)
    if ttl is None:
        ttl = 8.0 if is_trading_time() else 300.0
    fresh = snap["fetchedAt"] and (time.time() - snap["fetchedAt"] < ttl)
    if fresh and snap["quotes"]:
        return snap
    try:
        return refresh()
    except Exception as exc:
        snap["error"] = str(exc)
        return snap


def warm_up() -> None:
    """后台预热，避免首个请求等待。"""
    def run():
        try:
            refresh()
        except Exception as exc:
            with _snap_lock:
                SNAPSHOT["error"] = str(exc)
    threading.Thread(target=run, daemon=True).start()


# ---------------------------------------------------------------- 成交额历史

def _turnover_file() -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, "turnover.json")


def _record_turnover(trade_day: str | None) -> None:
    """记录每个交易日的全市场成交额，用于「比昨日」增减量。"""
    if not trade_day:
        return
    with _snap_lock:
        total = sum(q["turnover"] for q in SNAPSHOT["quotes"].values() if q.get("turnover"))
    try:
        hist = {}
        path = _turnover_file()
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                hist = json.load(fh)
        prev = hist.get(trade_day)
        if prev is None or abs(prev - total) > 1:
            hist[trade_day] = total
            hist = dict(sorted(hist.items())[-40:])
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(hist, fh)
    except Exception:
        pass


_INDEX_AMT_CACHE = {"at": 0.0, "data": {}}   # date -> 两市成交额(元)
_INDEX_AMT_TTL = 600.0                        # 10 分钟内复用


def _index_turnover_history(days: int = 8) -> dict:
    """指数日K成交额 {"two": {日期: 元}, "bj": {日期: 元}}。

    腾讯 newfqkline 每行第 9 个字段是当日成交额（万元）：沪市 sh000001 +
    深市 sz399107 = 两市合计（不含北交所）；北交所没有全样本指数，用北证50
    （bj899050，覆盖北交所绝大部分成交额）的日K做**比例**折算。
    """
    now = time.time()
    if now - _INDEX_AMT_CACHE["at"] < _INDEX_AMT_TTL and _INDEX_AMT_CACHE["data"]:
        return _INDEX_AMT_CACHE["data"]
    two: dict[str, float] = {}
    bj: dict[str, float] = {}
    for sym in MARKET_INDEX_SYMBOLS:
        try:
            raw = _http_get(KLINE_URL % (sym, days), timeout=15).decode("utf-8", "ignore")
            data = json.loads(raw).get("data", {}).get(sym, {})
            rows = data.get("qfqday") or data.get("day") or []
        except Exception:
            continue
        for r in rows:
            try:
                two[r[0]] = two.get(r[0], 0.0) + float(r[8]) * 1e4
            except (IndexError, ValueError, TypeError):
                continue
    try:
        raw = _http_get(KLINE_URL % (BJ_PROXY_SYMBOL, days), timeout=15).decode("utf-8", "ignore")
        data = json.loads(raw).get("data", {}).get(BJ_PROXY_SYMBOL, {})
        for r in data.get("qfqday") or data.get("day") or []:
            try:
                bj[r[0]] = float(r[8]) * 1e4
            except (IndexError, ValueError, TypeError):
                continue
    except Exception:
        pass
    out = {"two": two, "bj": bj}
    if two:
        _INDEX_AMT_CACHE["at"] = now
        _INDEX_AMT_CACHE["data"] = out
    return out


def _previous_turnover(trade_day: str | None, today_total: float = 0.0) -> float:
    """昨日全市场成交额（元）。

    优先用本地按日累计的历史（最准）；否则用指数日K外推：
        昨日全市场 ≈ 昨日两市成交额 + 今日北交所成交额 × (北证50 昨日/今日成交额)
    实测与线上原站误差 <0.01%。
    """
    if not trade_day:
        return 0.0
    try:
        path = _turnover_file()
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                hist = json.load(fh)
            days = [d for d in sorted(hist) if d < trade_day]
            if days:
                return float(hist[days[-1]])
    except Exception:
        pass
    try:
        series = _index_turnover_history()
        two, bj = series["two"], series["bj"]
        prev_days = [d for d in sorted(two) if d < trade_day]
        if not prev_days:
            return 0.0
        prev_day = prev_days[-1]
        prev = two[prev_day]
        # 今日两市（指数口径）与个股合计的差额即北交所等未计入指数的部分，
        # 用北证50 昨/今成交额比例把这块折算到昨日。
        today_two = two.get(trade_day, 0.0)
        if today_two > 0 and today_total > today_two:
            bj_today = today_total - today_two
            bj_prev_ratio = (bj.get(prev_day, 0.0) / bj[trade_day]) if bj.get(trade_day) else 0.0
            prev += bj_today * bj_prev_ratio
        return float(prev)
    except Exception:
        return 0.0


# ---------------------------------------------------------------- 聚合输出

def _pct_of(rec: dict, period: str):
    """周期涨跌幅。非日周期若该周期无值（新股上市不足 5/20 日）返回 None ——
    与原站一致：这类股票 changePct 为 null，且不计入涨跌家数与加权。"""
    if not rec:
        return 0.0 if period == "day" else None
    v = rec.get(PERIOD_FIELD.get(period, "pctDay"))
    if v is None:
        if period != "day":
            return None
        v = rec.get("pctDay")           # 日周期：停牌股无当日涨跌幅时按 0 处理
    return float(v) if v is not None else None


def _round_or_none(v, nd: int = 2):
    """保留 null 语义的取整（非日周期无涨跌幅的新股返回 None）。"""
    return None if v is None else round(v, nd)


def _weighted(pairs):
    """(value, pct) 加权平均。"""
    num = den = 0.0
    for value, pct in pairs:
        if value and value > 0 and pct is not None:
            num += value * pct
            den += value
    return (num / den) if den else 0.0


ADVANCE_EPS = 0.1          # 线上 API 汇总的判平阈值：|涨跌幅| ≤ 0.1% 记平盘


def _advance_stats(recs):
    """接口汇总的涨跌家数：与线上一致用 0.1% 判平阈值，且不剔除停牌股
    （实测 all-day = 745/109/4725 合计 5579、hs300-week = 100/5/195 合计 300）。

    注意：前端侧栏显示的家数是前端自己按市场分流口径重算的（A 股全图用严格正负
    并剔除零成交停牌股，其余市场用 0.1% 阈值），与此处接口汇总口径不同 ——
    这是原站本身就存在的两套口径。
    """
    advance = flat = decline = 0
    for r in recs:
        pct = r.get("changePct")
        if pct is None:                  # 该周期无涨跌幅（新股）：不计入任何一边
            continue
        if pct > ADVANCE_EPS:
            advance += 1
        elif pct < -ADVANCE_EPS:
            decline += 1
        else:
            flat += 1
    return advance, flat, decline


def _area_value(base: dict, q: dict, period: str = "day") -> float:
    """面积权重，按周期分流（实测原站两种口径确实不同）：

    - 日周期：以快照权重（原站流通市值股本）为基准、按实时价格折算，
      既保持与原站一致的板块/个股相对面积，又能随价格实时变化；
      实测日周期权重合计 165061 亿，与原站逐股相等。
    - 周/月/年周期：原站权重就等于腾讯实时流通市值（f44），精确到亿完全一致
      （601857 中国石油 20062 亿、600036 招商银行 8856 亿…），且三者权重相同。

    快照权重缺失时才退回腾讯的实时流通市值。LIVE_VALUE=1 时强制纯用实时市值。
    """
    static_value = base.get("staticValue") or 0.0
    q = q or {}
    if LIVE_VALUE or period != "day":
        return (q.get("floatValue") or 0.0) or static_value
    static_price = base.get("staticPrice") or 0.0
    live_price = q.get("price") or 0.0
    if static_value > 0 and static_price > 0 and live_price > 0:
        return static_value * (live_price / static_price)
    return (q.get("floatValue") or 0.0) or static_value


def build_treemap(market: str = "all", period: str = "day") -> dict:
    """生成 /api/heatmap/treemap 响应体（与 dpyt 同构）。"""
    snap = snapshot()
    quotes = snap["quotes"]
    meta = _by_code()
    codes = members(market, period)
    boards = {}
    joined = []
    for code in codes:
        base = meta.get(code)
        if not base:
            continue
        q = quotes.get(_qt_symbol(code))
        value = _area_value(base, q, period)
        node = {
            "code": code,
            "name": base["name"],
            "boardName": base["boardName"],
            "subBoardName": base["subBoardName"],
            "value": value,
            "exchange": base["exchange"],
            "price": round((q or {}).get("price") or 0.0, 2),
            "changePct": _round_or_none(_pct_of(q, period), 2),
            "turnoverAmount": round((q or {}).get("turnover") or 0.0, 0),
        }
        joined.append(node)
        boards.setdefault(base["boardName"], []).append(node)

    nodes = []
    for name, kids in boards.items():
        total = sum(k["value"] for k in kids)
        nodes.append({
            "code": _stable_id(name),
            "name": name,
            "value": total,
            "stockCount": len(kids),
            "children": sorted(kids, key=lambda k: -k["value"]),
        })
    nodes.sort(key=lambda n: -n["value"])

    advance, flat, decline = _advance_stats(joined)
    turnover = sum(n["turnoverAmount"] for n in joined)
    # 原站只有「A 股全图」给「比昨日」增减量，其它市场一律显示 --（其数据源不提供
    # 分市场的历史成交额），这里保持一致。
    prev_turnover = _previous_turnover(snap.get("tradeDate"), turnover) if market == "all" else 0.0
    idx_pct, basis = _market_pct(market, period, joined, prefer_index=False)

    return {
        "market": market,
        "period": period,
        "updatedAt": snap["updatedAt"],
        "stockCount": len(joined),
        "boardCount": len(nodes),
        "nodes": nodes,
        "source": "live" if snap["quotes"] else "stale",
        "summary": {
            "advanceCount": advance,
            "flatCount": flat,
            "declineCount": decline,
            "turnoverAmount": round(turnover, 0),
            "turnoverPreviousAmount": round(prev_turnover, 0),
            "turnoverDelta": round(turnover - prev_turnover, 0) if prev_turnover else 0,
            "indexChangePct": idx_pct,
            "indexChangeBasis": basis,
        },
    }


def _market_pct(market: str, period: str, recs, prefer_index: bool = True):
    """市场整体涨跌幅：prefer_index 时优先指数，否则用成分股流通市值加权。

    dpyt 原站口径：overview 用指数（basis=index），treemap.summary 用加权
    （basis=weighted，例如全图 -1.05 与指数的 -1.58 并存），此处保持同一行为。
    """
    sym, _index_name = MARKET_INDEX.get(market, (None, MARKET_LABEL.get(market, "")))
    field = PERIOD_FIELD.get(period, "pctDay")
    if prefer_index and sym:
        idx = snapshot()["indices"].get(sym) or {}
        v = idx.get(field)
        if v is None and period == "day":
            v = idx.get("pctDay")
        if v is not None:
            return float(v), "index"
    return round(_weighted([(r["value"], r["changePct"]) for r in recs]), 6), "weighted"


def build_overview(period: str = "day") -> dict:
    snap = snapshot()
    quotes = snap["quotes"]
    meta = _by_code()
    markets = []
    for market, (sym, index_name) in MARKET_INDEX.items():
        codes = members(market, period)
        recs = []
        for code in codes:
            base = meta.get(code)
            if not base:
                continue
            q = quotes.get(_qt_symbol(code)) or {}
            recs.append({
                "value": _area_value(base, q, period),
                "changePct": _pct_of(q, period),
            })
        pct, basis = _market_pct(market, period, recs)
        item = {
            "market": market,
            "basis": basis,
            "changePct": pct,
            "stockCount": len(recs),
            "updatedAt": snap["updatedAt"],
        }
        if basis == "index":
            item["indexName"] = index_name
        markets.append(item)
    return {
        "period": period,
        "updatedAt": snap["updatedAt"],
        "source": "live" if snap["quotes"] else "stale",
        "markets": markets,
    }


def build_quotes(period: str = "day", codes=None) -> dict:
    """报价字典：键同时提供「代码.交易所」与原站裸码两种形式。"""
    snap = snapshot()
    quotes = snap["quotes"]
    meta = _by_code()
    pool = codes if codes else list(meta.keys())
    out = {}
    for code in pool:
        key = code if "." in code else code + "." + (meta.get(code, {}).get("exchange", ""))
        q = quotes.get(_qt_symbol(key))
        if not q:
            continue
        item = {
            "price": q.get("price"),
            "changePct": _round_or_none(_pct_of(q, period), 2),
            "turnoverAmount": round(q.get("turnover") or 0.0, 0),
        }
        out[key] = item
        bare = key.split(".")[0]
        if bare not in out:
            out[bare] = item
    return {"period": period, "updatedAt": snap["updatedAt"], "quotes": out}


def build_stream(period: str = "day") -> str:
    """NDJSON（三行），与原站 /api/heatmap/quotes/stream 的帧结构一致。"""
    snap = snapshot()
    data = build_quotes(period)
    quotes = data["quotes"]
    total = len({k.split(".")[0] for k in quotes})
    lines = [
        json.dumps({"type": "start", "totalCount": total}, ensure_ascii=False),
        json.dumps({
            "type": "quotes",
            "loadedCount": total,
            "totalCount": total,
            "updatedAt": snap["updatedAt"],
            "quotes": quotes,
        }, ensure_ascii=False),
        json.dumps({
            "type": "complete",
            "loadedCount": total,
            "totalCount": total,
            "updatedAt": snap["updatedAt"],
            "source": "live" if snap["quotes"] else "stale",
        }, ensure_ascii=False),
    ]
    return "\n".join(lines) + "\n"


def status() -> dict:
    snap = snapshot(ttl=0) if not SNAPSHOT["quotes"] else dict(SNAPSHOT)
    return {
        "universe": len(universe()),
        "quoteCount": snap.get("count", 0),
        "updatedAt": snap.get("updatedAt"),
        "tradeDate": snap.get("tradeDate"),
        "ageSeconds": round(time.time() - snap["fetchedAt"], 1) if snap.get("fetchedAt") else None,
        "elapsed": snap.get("elapsed"),
        "tradingTime": is_trading_time(),
        "error": snap.get("error"),
        "markets": {k: len(v) for k, v in _members.items()} if _members else {},
        "indexPct": {k: (v or {}).get("pctDay") for k, v in (snap.get("indices") or {}).items()},
    }


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "status":
        print(json.dumps(status(), ensure_ascii=False, indent=2))
    else:
        snap = refresh()
        print(json.dumps(status(), ensure_ascii=False, indent=2))
        tm = build_treemap("all", "day")
        print("treemap boards=%d stocks=%d summary=%s" % (
            tm["boardCount"], tm["stockCount"],
            json.dumps(tm["summary"], ensure_ascii=False)))
        print("overview:", json.dumps(build_overview("day")["markets"], ensure_ascii=False))

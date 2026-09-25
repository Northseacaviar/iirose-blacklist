#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
成本账工具：从本机 Hermes 的 state.db（只读）里统计【本项目】花掉的 token 与估算花费。

用法：
    python tools/token-report.py                     # 默认读 D:/insane-robot/state.db
    python tools/token-report.py <state.db 路径>

口径（写在 docs/成本账.md 里，改口径请同步改那篇文章）：
    - 直接相关：CLI/Telegram 主会话（用 --session 前缀指定）+ 所有 source=subagent 且首条用户消息提到本项目的会话；
    - 部分相关：其他会话里含「拉黑/悬浮/屏蔽/blacklist」的讨论，按消息行数占比折算（粗略，仅供参考）；
    - estimated_cost_usd 是 Hermes 的估算，不是实付；reasoning_tokens 可能已含在 output 口径里，四项分开列。
"""
import sqlite3
import sys
import datetime

DB = sys.argv[1] if len(sys.argv) > 1 else 'D:/insane-robot/state.db'

# 本项目在 state.db 里的关联方式
MAIN_PREFIXES = ('20260925_1634',)          # 本项目主会话（CLI）
SUBAGENT_HINT = ('iirose-blacklist', '拉黑', '屏蔽')
PARTIAL_HINTS = ('拉黑', '悬浮', '屏蔽', 'blacklist')
PARTIAL_SESSIONS = ('20260925_1238',)       # 手机端那场，部分内容是本项目

con = sqlite3.connect('file:%s?mode=ro' % DB, uri=True)
cur = con.cursor()


def bj(ts):
    return datetime.datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M') if ts else '-'


def fetch(sid):
    return cur.execute('''select id, source, title, model, started_at, message_count, tool_call_count,
                          input_tokens, output_tokens, cache_read_tokens, reasoning_tokens,
                          estimated_cost_usd, cost_status
                          from sessions where id = ?''', (sid,)).fetchone()


def print_row(r, note=''):
    (sid, source, title, model, st, mc, tc, i, o, cr, rz, cost, status) = r
    i, o, cr, rz, cost = i or 0, o or 0, cr or 0, rz or 0, cost or 0.0
    print('%-13s | %-8s | %s | 消息 %-4s 工具 %-4s | 输入 %-9s 输出 %-8s 缓存读 %-10s 推理 %-8s | $%.4f %s%s'
          % (sid[:13], source, bj(st), mc, tc, i, o, cr, rz, cost, status or '-', ('  ' + note) if note else ''))
    return dict(id=sid, source=source, started=st, msg=mc or 0, tool=tc or 0, i=i, o=o, cr=cr, rz=rz, cost=cost)


print('== 直接相关 ==')
rows = []
for p in MAIN_PREFIXES:
    sid = cur.execute('select id from sessions where id like ?', (p + '%',)).fetchone()
    if sid:
        rows.append(print_row(fetch(sid[0]), '(本项目主会话)'))
for (sid,) in cur.execute("select id from sessions where source = 'subagent'").fetchall():
    first = cur.execute('''select content from messages where session_id = ? and role = 'user'
                           order by rowid limit 1''', (sid,)).fetchone()
    first = str(first[0]) if first and first[0] else ''
    if any(h in first for h in SUBAGENT_HINT):
        rows.append(print_row(fetch(sid), '(子 agent 审查)'))

print()
print('== 部分相关（按消息行数占比折算，粗略）==')
for p in PARTIAL_SESSIONS:
    sid = cur.execute('select id from sessions where id like ?', (p + '%',)).fetchone()
    if not sid:
        continue
    sid = sid[0]
    r = fetch(sid)
    tot = cur.execute('select count(*) from messages where session_id = ?', (sid,)).fetchone()[0]
    like = ' or '.join(['content like ?'] * len(PARTIAL_HINTS))
    hit = cur.execute('select count(*) from messages where session_id = ? and (%s)' % like,
                      (sid,) + tuple('%%%s%%' % h for h in PARTIAL_HINTS)).fetchone()[0]
    share = (hit / float(tot)) if tot else 0.0
    d = print_row(r, '(部分相关，行数占比 %.0f%% → 折算 $%.4f)' % (share * 100, (r[11] or 0) * share))
    d['cost'] = d['cost'] * share
    for k in ('i', 'o', 'cr', 'rz', 'msg', 'tool'):
        d[k] = int(d[k] * share)
    rows.append(d)

print()
T = {k: sum(r[k] for r in rows) for k in ('msg', 'tool', 'i', 'o', 'cr', 'rz', 'cost')}
print('== 合计 ==')
print('消息 %d · 工具调用 %d' % (T['msg'], T['tool']))
print('输入 %d · 输出 %d · 缓存读 %d · 推理 %d' % (T['i'], T['o'], T['cr'], T['rz']))
print('四项相加 = %d（推理可能已含在输出口径里，别当独立增量）' % (T['i'] + T['o'] + T['cr'] + T['rz']))
print('估算花费 $%.4f（cost_status 多为 estimated，非实付）' % T['cost'])

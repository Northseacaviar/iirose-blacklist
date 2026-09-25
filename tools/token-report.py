#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
项目成本核算（通用版）—— 从本机 Hermes 的 state.db【只读】统计某个项目的 token 与估算花费。

用法一（推荐）：复制到项目 tools/ 里，改下面 CONFIG，然后 `python tools/token-report.py`
用法二（CLI 覆盖）：
    python token-report.py --label "我的项目" --project D:/myproj \
        --session 20260925_1634 --keyword myproj --partial 20260925_1238 --partial-hint 悬浮 --md

归属规则（为什么这么算，写进 docs/成本账.md 里）：
    A. 直接全额计入：① cwd 命中项目目录的会话；② 明确指定的主会话前缀；③ source=subagent 且首条用户消息含关键词的会话（独立审查）。
    B. 部分相关折算：指定会话里按「含关键词的消息行数占比」折算（粗略近似，只做横向比较）。
口径提醒：estimated_cost_usd 是估算不是账单；reasoning_tokens 通常已含在 output 口径里，四项分开列、别相加。
"""
import sqlite3
import sys
import datetime

CONFIG = {
    'db': 'D:/insane-robot/state.db',
    'label': 'iirose 拉黑插件（iirose-blacklist）',
    'project_dir': 'D:/iirose-blacklist',
    'main_sessions': ['20260925_1634'],   # 本项目主会话（CLI）。换新会话（/new）后把它加进来，旧的留着别删
    'keywords': ['拉黑', '屏蔽', 'iirose-blacklist'],
    'partial_sessions': ['20260925_1238'],   # 手机端 Telegram 那场：部分内容是本项目
    'partial_hints': ['拉黑', '悬浮', '屏蔽', 'blacklist'],
}


def apply_cli(cfg):
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        a = args[i]
        i += 1
        if a == '--md':
            cfg['md'] = True
            continue
        if i >= len(args):
            break
        v = args[i]
        i += 1
        if a == '--db':
            cfg['db'] = v
        elif a == '--label':
            cfg['label'] = v
        elif a == '--project':
            cfg['project_dir'] = v
        elif a == '--session':
            cfg['main_sessions'].append(v)
        elif a == '--keyword':
            cfg['keywords'].append(v)
        elif a == '--partial':
            cfg['partial_sessions'].append(v)
        elif a == '--partial-hint':
            cfg['partial_hints'].append(v)
    cfg.setdefault('md', False)
    return cfg


CFG = apply_cli(dict(CONFIG))
CFG['partial_hints'] = CFG['partial_hints'] or CFG['keywords']

con = sqlite3.connect('file:%s?mode=ro' % CFG['db'], uri=True)
cur = con.cursor()

SESS_COLS = '''id, source, title, started_at, message_count, tool_call_count, input_tokens, output_tokens,
               cache_read_tokens, reasoning_tokens, estimated_cost_usd, cost_status, cwd'''


def bj(ts):
    return datetime.datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M') if ts else '-'


def sess(sid_or_prefix):
    if len(sid_or_prefix) < 32:
        r = cur.execute('select %s from sessions where id like ?' % SESS_COLS, (sid_or_prefix + '%',)).fetchall()
        return r[0] if len(r) == 1 else (r[0] if r else None)
    return cur.execute('select %s from sessions where id = ?' % SESS_COLS, (sid_or_prefix,)).fetchone()


def first_user_msg(sid):
    r = cur.execute("select content from messages where session_id=? and role='user' order by rowid limit 1", (sid,)).fetchone()
    return str(r[0]) if r and r[0] else ''


def hit_lines(sid, hints):
    if not hints:
        return 0, 0
    tot = cur.execute('select count(*) from messages where session_id=?', (sid,)).fetchone()[0]
    like = ' or '.join(['content like ?'] * len(hints))
    hit = cur.execute('select count(*) from messages where session_id=? and (%s)' % like,
                      (sid,) + tuple('%%%s%%' % h for h in hints)).fetchone()[0]
    return hit, tot


def matched(r):
    return any(k and k in (r[2] or '') for k in CFG['keywords']) or any(k and k in first_user_msg(r[0]) for k in CFG['keywords'])


rows = []          # (label, row, weight)
seen = set()

# A① cwd 命中
if CFG['project_dir']:
    for r in cur.execute('select %s from sessions where cwd like ?' % SESS_COLS, ('%%%s%%' % CFG['project_dir'],)).fetchall():
        if r[0] not in seen:
            seen.add(r[0]); rows.append(('cwd 命中项目目录', r, 1.0))
# A② 指定的主会话
for p in CFG['main_sessions']:
    r = sess(p)
    if r and r[0] not in seen:
        seen.add(r[0]); rows.append(('指定主会话', r, 1.0))
# A③ 相关 subagent（独立审查）
for (sid,) in cur.execute("select id from sessions where source='subagent'").fetchall():
    if sid in seen:
        continue
    f = first_user_msg(sid)
    if any(k and k in f for k in CFG['keywords']):
        r = sess(sid)
        if r:
            seen.add(r[0]); rows.append(('子 agent（独立审查等）', r, 1.0))
# A④ 其余关键词命中的会话（标题或首条消息）——默认也直接计入
if CFG['keywords']:
    for r in cur.execute('select %s from sessions' % SESS_COLS).fetchall():
        if r[0] in seen:
            continue
        if matched(r):
            seen.add(r[0]); rows.append(('关键词命中', r, 1.0))
# B 部分相关
for p in CFG['partial_sessions']:
    r = sess(p)
    if not r or r[0] in seen:
        continue
    seen.add(r[0])
    hit, tot = hit_lines(r[0], CFG['partial_hints'])
    rows.append(('部分相关（按消息行数折算）', r, (hit / float(tot)) if tot else 0.0))
    CFG['_share_note'] = CFG.get('_share_note', [])
    CFG['_share_note'].append((hit, tot))

rows.sort(key=lambda x: x[1][3])

T = dict(msg=0, tool=0, i=0, o=0, cr=0, rz=0, cost=0.0)
table, plain = [], []
for label, r, w in rows:
    (sid, source, title, st, mc, tc, i, o, cr, rz, cost, status, cwd) = r
    mc, tc = int((mc or 0) * w), int((tc or 0) * w)
    i, o, cr, rz = int((i or 0) * w), int((o or 0) * w), int((cr or 0) * w), int((rz or 0) * w)
    cost = (cost or 0.0) * w
    T['msg'] += mc; T['tool'] += tc; T['i'] += i; T['o'] += o; T['cr'] += cr; T['rz'] += rz; T['cost'] += cost
    note = '全额' if w == 1.0 else '折算 %.0f%%' % (w * 100)
    plain.append('%-13s | %-9s | %s | 消息 %-4s 工具 %-4s | 输入 %-9s 输出 %-8s 缓存读 %-10s 推理 %-8s | $%.4f | %s'
                 % (sid[:13], source, bj(st), mc, tc, i, o, cr, rz, cost, note))
    table.append('| %s（`%s…`）| %s | %s | %s | %s | %s | %s | %s | %.4f | %s |'
                 % (label, sid[:13], bj(st)[5:], format(mc, ','), format(tc, ','), format(i, ','),
                    format(o, ','), format(cr, ','), format(rz, ','), cost, note))

was_reason = '推理可能已含在输出口径里'
if CFG['md']:
    print('| 会话 | 开始 | 消息 | 工具调用 | 输入 | 输出 | 缓存读 | 推理 | 估算(USD) | 计入 |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    print('\n'.join(table))
    print()
    print('- 消息 **%s** · 工具调用 **%s**' % (format(T['msg'], ','), format(T['tool'], ',')))
    print('- 输入 **%s** · 输出 **%s** · 缓存读 **%s** · 推理 **%s**'
          % (format(T['i'], ','), format(T['o'], ','), format(T['cr'], ','), format(T['rz'], ',')))
    print('- 四项相加 = **%s**（%s，别当独立增量）' % (format(T['i'] + T['o'] + T['cr'] + T['rz'], ','), was_reason))
    print('- 估算花费 **$%.4f**' % T['cost'])
else:
    print('== %s · 成本核算（来源：%s，只读）==' % (CFG['label'], CFG['db']))
    print('\n'.join(plain))
    print()
    print('合计：消息 %s · 工具调用 %s' % (format(T['msg'], ','), format(T['tool'], ',')))
    print('      输入 %s · 输出 %s · 缓存读 %s · 推理 %s'
          % (format(T['i'], ','), format(T['o'], ','), format(T['cr'], ','), format(T['rz'], ',')))
    print('      四项相加 %s（%s）· 估算花费 $%.4f'
          % (format(T['i'] + T['o'] + T['cr'] + T['rz'], ','), was_reason, T['cost']))
    if CFG.get('_share_note'):
        for hit, tot in CFG['_share_note']:
            print('      部分相关折算依据：%d/%d 行命中关键词' % (hit, tot))

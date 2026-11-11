// Share management (require login).
// GET    /api/shares          -> list all shares (kind: card | conversation | paper) with titles
// POST   /api/shares          -> { action: 'create', kind: 'card'|'conversation'|'paper',
//                                  cardId?|conversationId?|paperId?, days?, messageIds? } 创建分享
//                             -> { ids, days } batch extend expiry (days=0 → 永久)
// DELETE /api/shares?ids=a,b  -> batch cancel shares（对话/试卷分享会一并清理内容快照）
//
// ── 分享所选消息（messageIds）的实现说明 ──
// Share 模型无可存 JSON 消息列表的字段且 schema 不允许改动，而公开分享读取端
// /api/share/:token 只认 refId 指向的对话。因此「只分享勾选的消息」采用快照方
// 案：把勾选的消息复制为一条 type='shared' 的快照对话（不出现在对话列表/搜索
// 中，见 conversations/route.ts），Share.refId 指向快照；Share.cardId（对话分享
// 场景原本恒为空串）复用存放 { sourceId, messageIds } 元数据，便于溯源与统计。
// 这样公开端无需任何改动、且天然不泄露未勾选的消息。
//
// ── 试卷分享（kind='paper'）的快照说明 ──
// 与对话「分享所选消息」同款快照思路：把整份试卷复制为一条 source='shared' 的快照
// 试卷（不进入试卷夹列表，papers-view 按 source 过滤），Share.refId 指向快照，
// 公开端 /api/share/:token 只读快照 → 分享后原卷修改/删除均不影响分享页。
// Share.cardId（试卷分享场景无书卡语义）复用存放 { sourceId, cardId } 元数据：
// sourceId = 源试卷 id，用于「已有该试卷的分享则复用更新」的去重匹配；cardId =
// 源试卷所属书本 id，便于溯源。重新分享同一份试卷会复用 Share 并刷新快照内容。
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'

/** 分享快照对话的 type（与 conversations/route.ts 的排除过滤保持一致）。 */
const SHARED_SNAPSHOT_TYPE = 'shared'

/** 分享快照试卷的 source（papers-view 按 source='shared' 过滤，不进入试卷夹列表）。 */
const PAPER_SNAPSHOT_SOURCE = 'shared'

/** 试卷分享的 Share.cardId 元数据（复用字段存放，与对话快照元数据同思路）。 */
function paperShareMeta(paperId: string, cardId: string): string {
  return JSON.stringify({ sourceId: paperId, cardId })
}

/** 解析试卷分享的 Share.cardId 元数据（损坏时返回 null）。 */
function parsePaperShareMeta(cardId: string): { sourceId: string; cardId: string } | null {
  try {
    const v = JSON.parse(cardId) as { sourceId?: unknown; cardId?: unknown }
    if (typeof v.sourceId === 'string' && v.sourceId) {
      return { sourceId: v.sourceId, cardId: typeof v.cardId === 'string' ? v.cardId : '' }
    }
  } catch {
    /* 非法元数据按无源卷处理 */
  }
  return null
}

function genToken(): string {
  return (
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  ).slice(0, 24)
}

export async function GET() {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
    // 维护性清扫：孤儿快照对话（type='shared' 但已无任何 share 指向）一并删除。
    // 覆盖 /api/shares/:id 单条删除（该端点不感知快照）遗留的孤儿数据。
    const snapshotRows = await db.conversation.findMany({
      where: { type: SHARED_SNAPSHOT_TYPE },
      select: { id: true },
    })
    if (snapshotRows.length > 0) {
      const snapshotIds = snapshotRows.map((r) => r.id)
      const liveShares = await db.share.findMany({
        where: { kind: 'conversation', refId: { in: snapshotIds } },
        select: { refId: true },
      })
      const live = new Set(liveShares.map((s) => s.refId))
      const orphans = snapshotIds.filter((id) => !live.has(id))
      if (orphans.length > 0) {
        await db.chatMessage.deleteMany({ where: { conversationId: { in: orphans } } })
        await db.conversation.deleteMany({ where: { id: { in: orphans } } })
      }
    }
    // 维护性清扫：孤儿试卷快照（source='shared' 但已无任何 paper 分享指向）一并删除
    // （同样覆盖 /api/shares/:id 单条删除不感知快照的缺口）。
    const paperSnapRows = await db.paper.findMany({
      where: { source: PAPER_SNAPSHOT_SOURCE },
      select: { id: true },
    })
    if (paperSnapRows.length > 0) {
      const paperSnapIds = paperSnapRows.map((r) => r.id)
      const livePaperShares = await db.share.findMany({
        where: { kind: 'paper', refId: { in: paperSnapIds } },
        select: { refId: true },
      })
      const livePaper = new Set(livePaperShares.map((s) => s.refId))
      const orphanPapers = paperSnapIds.filter((id) => !livePaper.has(id))
      if (orphanPapers.length > 0) {
        await db.paper.deleteMany({ where: { id: { in: orphanPapers } } })
      }
    }
    const shares = await db.share.findMany({ orderBy: { createdAt: 'desc' } })
    // 批量取卡片标题（kind=card）
    const cardIds = Array.from(new Set(shares.filter((s) => s.kind === 'card').map((s) => s.cardId)))
    const cardRows = cardIds.length
      ? await db.card.findMany({ where: { id: { in: cardIds } }, select: { id: true, title: true } })
      : []
    const titleMap = new Map(cardRows.map((c) => [c.id, c.title]))
    // 批量取对话标题（kind=conversation）
    const convIds = Array.from(new Set(shares.filter((s) => s.kind === 'conversation').map((s) => s.refId)))
    const convRows = convIds.length
      ? await db.conversation.findMany({ where: { id: { in: convIds } }, select: { id: true, title: true } })
      : []
    const convTitleMap = new Map(convRows.map((c) => [c.id, c.title]))
    // 批量取试卷快照标题（kind=paper，refId 指向快照试卷）
    const paperIds = Array.from(new Set(shares.filter((s) => s.kind === 'paper').map((s) => s.refId)))
    const paperRows = paperIds.length
      ? await db.paper.findMany({ where: { id: { in: paperIds } }, select: { id: true, title: true } })
      : []
    const paperTitleMap = new Map(paperRows.map((p) => [p.id, p.title]))
    return NextResponse.json({
      shares: shares.map((s) => ({
        id: s.id,
        token: s.token,
        kind: s.kind,
        cardId: s.cardId,
        refId: s.refId,
        title:
          s.kind === 'paper'
            ? s.title || paperTitleMap.get(s.refId) || '（试卷已删除）'
            : s.kind === 'conversation'
              ? s.title || convTitleMap.get(s.refId) || '（对话已删除）'
              : titleMap.get(s.cardId) ?? '（卡片已删除）',
        // kind='paper' 时为源试卷 id（试卷夹「已分享」标记匹配用），其余为空串
        paperId: s.kind === 'paper' ? (parsePaperShareMeta(s.cardId)?.sourceId ?? '') : '',
        expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
        createdAt: s.createdAt.toISOString(),
      })),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[GET /api/shares] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
    const body = await req.json().catch(() => ({}))

    // ---- 创建分享（书籍内容 / AI 对话 / 对话所选消息 / 试卷）----
    if (body?.action === 'create') {
      const kind =
        body.kind === 'conversation'
          ? 'conversation'
          : body.kind === 'paper'
            ? 'paper'
            : 'card'
      const days =
        typeof body.days === 'number' && Number.isFinite(body.days)
          ? Math.round(body.days)
          : 0
      const expiresAt = days === 0 ? null : new Date(Date.now() + days * 86400 * 1000)
      if (kind === 'conversation') {
        const conversationId = typeof body.conversationId === 'string' ? body.conversationId : ''
        if (!conversationId) return NextResponse.json({ error: '缺少 conversationId' }, { status: 400 })
        const conv = await db.conversation.findUnique({ where: { id: conversationId } })
        if (!conv) return NextResponse.json({ error: '对话不存在' }, { status: 404 })
        const messageIds: string[] = Array.isArray(body.messageIds)
          ? body.messageIds.filter((x: unknown): x is string => typeof x === 'string' && x.length > 0).slice(0, 500)
          : []

        // ---- 分享所选消息：复制勾选消息为快照对话（见文件头说明） ----
        if (messageIds.length > 0) {
          const msgs = await db.chatMessage.findMany({
            where: { conversationId, id: { in: messageIds } },
            orderBy: { createdAt: 'asc' },
          })
          if (msgs.length === 0) {
            return NextResponse.json({ error: '所选消息不存在或已被删除' }, { status: 400 })
          }
          const snapshot = await db.conversation.create({
            data: {
              title: conv.title,
              type: SHARED_SNAPSHOT_TYPE,
              cardId: '',
              ord: 999_999,
            },
          })
          await db.chatMessage.createMany({
            data: msgs.map((m) => ({
              conversationId: snapshot.id,
              role: m.role,
              content: m.content,
              images: m.images,
              createdAt: m.createdAt,
            })),
          })
          const created = await db.share.create({
            data: {
              token: genToken(),
              kind,
              refId: snapshot.id,
              // cardId 复用为快照元数据（对话分享原本恒为 ''）
              cardId: JSON.stringify({ sourceId: conversationId, messageIds: msgs.map((m) => m.id) }),
              title: conv.title,
              expiresAt,
            },
          })
          return NextResponse.json({
            share: { id: created.id, token: created.token, kind, refId: conversationId, title: conv.title, messageCount: msgs.length },
          })
        }

        // ---- 整对话分享：主对话不允许（只能勾选消息分享） ----
        if (conv.isMain) {
          return NextResponse.json({ error: '主对话请勾选消息后分享' }, { status: 400 })
        }
        // 已有有效分享则复用（仅复用整对话分享，不吞消息快照分享）
        const existing = await db.share.findFirst({
          where: { kind, refId: conversationId, cardId: '' },
        })
        if (existing) {
          const upd = await db.share.update({ where: { id: existing.id }, data: { expiresAt, title: conv.title } })
          return NextResponse.json({ share: { id: upd.id, token: upd.token, kind, refId: conversationId, title: conv.title } })
        }
        const created = await db.share.create({
          data: { token: genToken(), kind, refId: conversationId, cardId: '', title: conv.title, expiresAt },
        })
        return NextResponse.json({ share: { id: created.id, token: created.token, kind, refId: conversationId, title: conv.title } })
      }

      // ---- 试卷分享：整卷复制为 source='shared' 快照试卷，Share.refId 指向快照 ----
      if (kind === 'paper') {
        const paperId = typeof body.paperId === 'string' ? body.paperId : ''
        if (!paperId) return NextResponse.json({ error: '缺少 paperId' }, { status: 400 })
        const paper = await db.paper.findUnique({ where: { id: paperId } })
        if (!paper) return NextResponse.json({ error: '试卷不存在' }, { status: 404 })
        const meta = paperShareMeta(paper.id, paper.cardId)
        // 已有该试卷的分享则复用更新：刷新有效期 + 快照内容（重新分享 = 同步最新试卷）
        const existing = await db.share.findFirst({ where: { kind: 'paper', cardId: meta } })
        if (existing) {
          let refId = existing.refId
          const snap = await db.paper.findUnique({ where: { id: refId }, select: { id: true } })
          if (snap) {
            await db.paper.update({
              where: { id: refId },
              data: { title: paper.title, items: paper.items, cardTitle: paper.cardTitle },
            })
          } else {
            // 快照意外缺失（如被单独清理）→ 重建快照并重新指向
            const rebuilt = await db.paper.create({
              data: {
                cardId: '',
                cardTitle: paper.cardTitle,
                title: paper.title,
                items: paper.items,
                source: PAPER_SNAPSHOT_SOURCE,
              },
            })
            refId = rebuilt.id
          }
          const upd = await db.share.update({
            where: { id: existing.id },
            data: { refId, expiresAt, title: paper.title },
          })
          return NextResponse.json({
            share: {
              id: upd.id,
              token: upd.token,
              kind: 'paper',
              paperId,
              title: paper.title,
              expiresAt: expiresAt ? expiresAt.toISOString() : null,
            },
          })
        }
        const snapshot = await db.paper.create({
          data: {
            cardId: '',
            cardTitle: paper.cardTitle,
            title: paper.title,
            items: paper.items,
            source: PAPER_SNAPSHOT_SOURCE,
          },
        })
        const created = await db.share.create({
          data: { token: genToken(), kind: 'paper', refId: snapshot.id, cardId: meta, title: paper.title, expiresAt },
        })
        return NextResponse.json({
          share: {
            id: created.id,
            token: created.token,
            kind: 'paper',
            paperId,
            title: paper.title,
            expiresAt: expiresAt ? expiresAt.toISOString() : null,
          },
        })
      }

      const cardId = typeof body.cardId === 'string' ? body.cardId : ''
      if (!cardId) return NextResponse.json({ error: '缺少 cardId' }, { status: 400 })
      const card = await db.card.findUnique({ where: { id: cardId }, select: { title: true } })
      if (!card) return NextResponse.json({ error: '卡片不存在' }, { status: 404 })
      const existing = await db.share.findFirst({ where: { kind: 'card', cardId } })
      if (existing) {
        const upd = await db.share.update({ where: { id: existing.id }, data: { expiresAt } })
        return NextResponse.json({ share: { id: upd.id, token: upd.token, kind: 'card', cardId } })
      }
      const created = await db.share.create({
        data: { token: genToken(), kind: 'card', cardId, refId: '', title: card.title, expiresAt },
      })
      return NextResponse.json({ share: { id: created.id, token: created.token, kind: 'card', cardId } })
    }

    const ids: string[] = Array.isArray(body?.ids)
      ? body.ids.filter((x: unknown): x is string => typeof x === 'string')
      : []
    const days = typeof body?.days === 'number' && Number.isFinite(body.days) ? Math.round(body.days) : null
    if (ids.length === 0 || days === null) {
      return NextResponse.json({ error: '参数不完整' }, { status: 400 })
    }
    const expiresAt = days === 0 ? null : new Date(Date.now() + days * 86400 * 1000)
    const res = await db.share.updateMany({ where: { id: { in: ids } }, data: { expiresAt } })
    return NextResponse.json({ updated: res.count })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/shares] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
    const idsParam = req.nextUrl.searchParams.get('ids') ?? ''
    const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length === 0) return NextResponse.json({ error: '缺少 ids' }, { status: 400 })
    // 取消分享前先找出指向快照对话/快照试卷的分享（取消时级联清理快照，防孤儿数据）
    const shares = await db.share.findMany({
      where: { id: { in: ids }, kind: { in: ['conversation', 'paper'] } },
      select: { refId: true, kind: true },
    })
    const snapshotIds: string[] = []
    const paperSnapIds: string[] = []
    for (const s of shares) {
      if (s.kind === 'paper') {
        // 试卷分享的 refId 恒指向 source='shared' 快照试卷
        paperSnapIds.push(s.refId)
        continue
      }
      const conv = await db.conversation.findUnique({
        where: { id: s.refId },
        select: { type: true },
      })
      if (conv?.type === SHARED_SNAPSHOT_TYPE) snapshotIds.push(s.refId)
    }
    const res = await db.share.deleteMany({ where: { id: { in: ids } } })
    if (snapshotIds.length > 0) {
      await db.chatMessage.deleteMany({ where: { conversationId: { in: snapshotIds } } })
      await db.conversation.deleteMany({ where: { id: { in: snapshotIds } } })
    }
    if (paperSnapIds.length > 0) {
      await db.paper.deleteMany({ where: { id: { in: paperSnapIds } } })
    }
    return NextResponse.json({ deleted: res.count })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DELETE /api/shares] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

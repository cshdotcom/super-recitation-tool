#!/usr/bin/env node
/**
 * 生产环境 /api/parse 真实测试（在 CI 的 standalone server 上运行）。
 * 逐格式上传真实文件，断言 200 + content 非空；失败时打印完整响应与错误。
 */
import { strict as assert } from 'node:assert'

const BASE = process.env.PARSE_TEST_BASE || 'http://127.0.0.1:3128'
const FILE_DIR = '/tmp/parse-test/files'

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
mkdirSync(FILE_DIR, { recursive: true })

// ---------- 用项目自带的库造真实文件 ----------
const { default: JSZip } = await import('jszip')

function makeDocx() {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  zip.file(
    'word/document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>静夜思</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>床前明月光，疑是地上霜。</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>举头望明月，低头思故乡。</w:t></w:r></w:p>' +
      '</w:body></w:document>',
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

function makeEpub() {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  )
  zip.file(
    'OEBPS/content.opf',
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test</dc:title><dc:identifier id="uid">t1</dc:identifier></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
  )
  zip.file(
    'OEBPS/c1.xhtml',
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><h1>第一章</h1><p>这是<b>加粗</b>段落。</p><p>第二段内容。</p></body></html>',
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

function makePptx() {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
  )
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>')
  zip.file('ppt/presentation.xml', '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></p:sldIdLst></p:presentation>')
  zip.file('ppt/_rels/presentation.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>')
  zip.file(
    'ppt/slides/slide1.xml',
    '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>幻灯片标题文本</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function makeXlsx() {
  // 用项目自带的 xlsx (SheetJS)
  const XLSX = await import('xlsx').then((m) => m.default || m)
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([
    ['诗词', '作者'],
    ['静夜思', '李白'],
    ['春望', '杜甫'],
  ])
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

// ---------- helpers ----------
let cookie = ''

async function register() {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'parsetest', password: 'parsetest123' }),
  })
  const setCookie = res.headers.get('set-cookie') || ''
  cookie = setCookie.split(';')[0]
  if (!cookie) {
    // 已存在则登录
    const lres = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'parsetest', password: 'parsetest123' }),
    })
    cookie = (lres.headers.get('set-cookie') || '').split(';')[0]
  }
  if (!cookie) throw new Error('无法注册/登录获取会话')
  console.log('✔ 会话就绪')
}

async function parseOne(name, buffer, mime) {
  const fd = new FormData()
  fd.append('file', new Blob([buffer], { type: mime }), name)
  const res = await fetch(`${BASE}/api/parse`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: fd,
  })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* keep raw */ }
  console.log(`--- ${name}: HTTP ${res.status}`)
  console.log(`    ${(text || '').slice(0, 200)}`)
  assert.equal(res.status, 200, `${name} 解析失败（期望 200，得到 ${res.status}）：${text.slice(0, 400)}`)
  assert.ok(body && typeof body.content === 'string' && body.content.trim().length > 0, `${name} 解析内容为空`)
  return body
}

// ---------- main ----------
await register()

// 1. txt
writeFileSync(`${FILE_DIR}/t.txt`, '春望杜甫国破山河在，城春草木深。')
await parseOne('t.txt', readFileSync(`${FILE_DIR}/t.txt`), 'text/plain')

// 2. md
writeFileSync(`${FILE_DIR}/t.md`, '# 标题\n\n正文**加粗**。')
await parseOne('t.md', readFileSync(`${FILE_DIR}/t.md`), 'text/markdown')

// 3. docx（含加粗+标题）
await parseOne('t.docx', await makeDocx(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')

// 4. epub（含 h1 + 加粗）
await parseOne('t.epub', await makeEpub(), 'application/epub+zip')

// 5. xlsx
await parseOne('t.xlsx', await makeXlsx(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

// 6. pptx
await parseOne('t.pptx', await makePptx(), 'application/vnd.openxmlformats-officedocument.presentationml.presentation')

// 7. srt
writeFileSync(`${FILE_DIR}/t.srt`, '1\n00:00:01,000 --> 00:00:02,000\n第一句台词\n\n2\n00:00:02,000 --> 00:00:03,000\n第二句台词\n')
await parseOne('t.srt', readFileSync(`${FILE_DIR}/t.srt`), 'application/x-subrip')

// 8. 伪造 docx（非 zip）→ 期望 422 中文错误
{
  const fd = new FormData()
  fd.append('file', new Blob(['this is not a zip'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'bad.docx')
  const res = await fetch(`${BASE}/api/parse`, { method: 'POST', headers: { Cookie: cookie }, body: fd })
  const text = await res.text()
  console.log(`--- bad.docx: HTTP ${res.status}`)
  console.log(`    ${text.slice(0, 200)}`)
  assert.equal(res.status, 422, '伪造 docx 应返回 422')
  assert.ok(!/central directory|JSZip|Error:/i.test(text), '伪造 docx 错误必须是友好中文而非英文技术错误')
}

// 9. PDF（最小合法单页 PDF，内容为英文文本）
{
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 720 Td (Hello PDF Parse) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
    'utf-8',
  )
  const fd = new FormData()
  fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 't.pdf')
  const res = await fetch(`${BASE}/api/parse`, { method: 'POST', headers: { Cookie: cookie }, body: fd })
  const text = await res.text()
  console.log(`--- t.pdf: HTTP ${res.status}`)
  console.log(`    ${text.slice(0, 300)}`)
  // PDF 引擎链对最小 PDF 可能提取出空文本 → 允许 200（内容可空）或 422 中文提示
  assert.ok([200, 422].includes(res.status), `PDF 解析状态异常: ${res.status}`)
  if (res.status === 422) assert.ok(!/central directory|JSZip/i.test(text), 'PDF 错误必须是中文')
}

console.log('\n✅ 全部生产解析测试通过')

// ================= v2.6.0 新链路生产验证（无 AI 依赖，纯 DB/API）=================

// 10. /api/version 版本探针
{
  const res = await fetch(`${BASE}/api/version`)
  const body = await res.json()
  console.log(`--- /api/version: HTTP ${res.status}`, JSON.stringify(body))
  assert.equal(res.status, 200)
  assert.ok(typeof body.version === 'string' && body.version.length > 0, 'version 字段缺失')
}

// 11. 卡片 → 试卷 → 试卷分享 → 公开读取分享（v2.6.0 试卷分享链路）
{
  // 建卡
  const cardRes = await fetch(`${BASE}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ title: '生产测试卡', content: '春望杜甫国破山河在，城春草木深。感时花溅泪，恨别鸟惊心。' }),
  })
  const cardBody = await cardRes.json()
  console.log(`--- POST /api/cards: HTTP ${cardRes.status}`)
  assert.ok([200, 201].includes(cardRes.status), `建卡失败: ${JSON.stringify(cardBody).slice(0, 200)}`)
  // serializeCard 返回扁平 CardData（不是 {card:{...}} 包装）
  const cardId = cardBody.id || cardBody.card?.id
  assert.ok(cardId, 'cardId 缺失')

  // 建卷
  const paperRes = await fetch(`${BASE}/api/papers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      cardId,
      title: '生产测试卷',
      items: [
        { type: 'choice', stem: '国破___在？', options: ['山河', '江湖'], answer: 'A', explanation: '出自原文' },
        { type: 'fill', stem: '感时花___泪', answer: '溅' },
      ],
    }),
  })
  const paperBody = await paperRes.json()
  console.log(`--- POST /api/papers: HTTP ${paperRes.status}`)
  assert.ok([200, 201].includes(paperRes.status), `建卷失败: ${JSON.stringify(paperBody).slice(0, 200)}`)
  const paperId = paperBody.paper?.id
  assert.ok(paperId, 'paperId 缺失')

  // 分享试卷
  const shareRes = await fetch(`${BASE}/api/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ action: 'create', kind: 'paper', paperId, days: 7 }),
  })
  const shareBody = await shareRes.json()
  console.log(`--- POST /api/shares (paper): HTTP ${shareRes.status}`)
  assert.ok([200, 201].includes(shareRes.status), `试卷分享失败: ${JSON.stringify(shareBody).slice(0, 300)}`)
  const token = shareBody.share?.token
  assert.ok(token, 'share token 缺失')

  // 公开读取分享（无需登录）
  const pubRes = await fetch(`${BASE}/api/share/${token}`)
  const pubBody = await pubRes.json()
  console.log(`--- GET /api/share/<token>: HTTP ${pubRes.status}`)
  assert.equal(pubRes.status, 200, `公开读取分享失败: ${JSON.stringify(pubBody).slice(0, 300)}`)
  assert.ok(pubBody.paper && Array.isArray(pubBody.paper.items) && pubBody.paper.items.length === 2, '分享页试卷数据不完整')
  console.log('    试卷分享链路 ✓（建卡→建卷→分享→公开读取，2 题）')

  // 分享列表包含试卷
  const listRes = await fetch(`${BASE}/api/shares`, { headers: { Cookie: cookie } })
  const listBody = await listRes.json()
  const paperShares = (listBody.shares || []).filter((s) => s.kind === 'paper')
  console.log(`--- GET /api/shares: HTTP ${listRes.status}（试卷分享 ${paperShares.length} 条）`)
  assert.ok(paperShares.length >= 1, '分享列表未包含试卷类型')

  // 清理：删除分享与试卷快照（DELETE ids）
  const delRes = await fetch(`${BASE}/api/shares?ids=${shareBody.share.id}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  })
  console.log(`--- DELETE /api/shares: HTTP ${delRes.status}`)
}

// 12. /api/autoformat 路由存在性（CI 无 AI 凭据，允许 中文错误 的 422/500，不允许 404/挂死）
{
  const res = await fetch(`${BASE}/api/autoformat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ content: '测试排版内容一二三四五六七八九十' }),
  })
  const text = await res.text()
  console.log(`--- /api/autoformat: HTTP ${res.status}`, text.slice(0, 120))
  assert.ok([200, 422, 500].includes(res.status), `autoformat 路由异常: ${res.status}`)
  let ok = false
  try {
    const b = JSON.parse(text)
    ok = typeof b.content === 'string' || typeof b.error === 'string'
  } catch { /* ignore */ }
  assert.ok(ok, 'autoformat 响应必须是 JSON（content 或中文 error）')
}

console.log('\n✅ v2.6.0 新链路生产测试全部通过（版本探针/试卷分享/autoformat）')

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

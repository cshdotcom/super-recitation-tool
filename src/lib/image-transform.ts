// 图片几何变换：旋转（90° 步进）+ 水平/垂直翻转。
// 复用方：浏览器相机裁剪模式 (camera-capture) + 图片 OCR 编辑器 (image-ocr-editor)。
// 输入 dataURL（或同源图片地址），输出烘焙了变换的新 dataURL (JPEG 0.92)。

/** 把任意角度归一化到 [0, 360) 并对齐到 90° 步进（-90 → 270，450 → 90） */
function normalizeQuarterTurn(rotate: number): 0 | 90 | 180 | 270 {
  const deg = ((Math.round(rotate / 90) * 90) % 360 + 360) % 360
  return deg as 0 | 90 | 180 | 270
}

/** 图片几何变换：旋转（90° 步进）+ 水平/垂直翻转。返回新 dataURL (JPEG 0.92)。 */
export function transformImage(
  src: string,
  opts: { rotate?: number; flipH?: boolean; flipV?: boolean },
): Promise<string> {
  const { rotate = 0, flipH = false, flipV = false } = opts
  const angle = normalizeQuarterTurn(rotate)
  return new Promise((resolve, reject) => {
    if (!src) {
      reject(new Error('图片地址为空'))
      return
    }
    const img = new Image()
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width
        const h = img.naturalHeight || img.height
        if (!w || !h) {
          reject(new Error('图片尺寸无效'))
          return
        }
        // 旋转 90°/270° 时画布宽高互换
        const swap = angle === 90 || angle === 270
        const canvas = document.createElement('canvas')
        canvas.width = swap ? h : w
        canvas.height = swap ? w : h
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('画布不可用'))
          return
        }
        // 变换顺序：平移到画布中心 → 旋转（顺时针）→ 翻转 → 居中绘制原图
        ctx.translate(canvas.width / 2, canvas.height / 2)
        ctx.rotate((angle * Math.PI) / 180)
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1)
        ctx.drawImage(img, -w / 2, -h / 2, w, h)
        const out = canvas.toDataURL('image/jpeg', 0.92)
        if (!out || out === 'data:,') {
          reject(new Error('图片导出失败'))
          return
        }
        resolve(out)
      } catch (err) {
        reject(err instanceof Error ? err : new Error('图片变换失败'))
      }
    }
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })
}

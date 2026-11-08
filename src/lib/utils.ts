import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 角标数字格式化：>100 显示 "99+"，>50 显示 "50+"，否则显示原数。
 * 用于所有计数角标（待复习、错题、收藏、项目卡片数等），避免角标溢出。
 */
export function formatBadge(n: number): string {
  if (n > 100) return '99+'
  if (n > 50) return '50+'
  return String(n)
}

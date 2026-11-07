import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "超级背书工具 · AI 记忆背诵助手",
  description:
    "由 AI 驱动的智能背诵工具：图片识别导入、AI 挖空、AI 出题、AI 督背、思维导图、TTS 朗读、语音识别打分，一站搞定你的背诵难题。",
  keywords: [
    "背书",
    "背诵",
    "AI 背诵",
    "挖空",
    "AI 出题",
    "思维导图",
    "TTS 朗读",
    "语音识别",
    "记忆助手",
  ],
  authors: [{ name: "超级背书工具" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "超级背书工具 · AI 记忆背诵助手",
    description: "图片识别、AI 挖空、AI 出题、AI 督背、思维导图、TTS、ASR 打分。",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster richColors position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}

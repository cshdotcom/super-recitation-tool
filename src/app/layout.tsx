import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { SwRegister } from "@/components/sw-register";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "背书吧 · AI 记忆背诵助手",
  description:
    "由 AI 驱动的智能背诵工具：图片/PDF/Word 导入、AI 挖空、AI 出题、AI 督背、思维导图、TTS 朗读、语音识别打分，一站搞定你的背诵难题。",
  keywords: [
    "背书吧",
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
  applicationName: "背书吧",
  authors: [{ name: "背书吧" }],
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "背书吧 · AI 记忆背诵助手",
    description: "图片识别、AI 挖空、AI 出题、AI 督背、思维导图、TTS、ASR 打分。",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#171717",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
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
          themes={["light", "dark", "green", "sepia", "system"]}
          disableTransitionOnChange
        >
          {children}
          <Toaster richColors position="top-center" />
          <SwRegister />
        </ThemeProvider>
      </body>
    </html>
  );
}

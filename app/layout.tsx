import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '从零开始学 AI · 从会回答，到能做事',
  description: '回到 AI 历史的岔路口，先猜一猜，再亲手试一试。一册可以阅读、看视频、运行代码和随时提问的交互书。',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
